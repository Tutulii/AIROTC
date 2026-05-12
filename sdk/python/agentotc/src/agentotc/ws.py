import asyncio
import json
import logging
import websockets
from typing import Callable, Dict, Any, List

from .errors import NetworkDisconnectError

logger = logging.getLogger("AgentOTC.WS")

class WsManager:
    def __init__(self, ws_url: str, api_key: str):
        self.ws_url = ws_url
        self.api_key = api_key
        
        self.ws = None
        self.reconnect_attempts = 0
        self.max_reconnect_attempts = 10
        self.is_manually_closed = False
        self.is_connected = False
        
        self._listeners: Dict[str, List[Callable]] = {}

    def on(self, event: str, callback: Callable):
        if event not in self._listeners:
            self._listeners[event] = []
        self._listeners[event].append(callback)

    def emit(self, event: str, *args, **kwargs):
        for callback in self._listeners.get(event, []):
            try:
                if asyncio.iscoroutinefunction(callback):
                    asyncio.create_task(callback(*args, **kwargs))
                else:
                    callback(*args, **kwargs)
            except Exception as e:
                logger.error(f"Error in WS event listener for {event}: {e}")

    async def connect(self):
        self.is_manually_closed = False
        
        if self.ws and not self.ws.closed:
            return

        try:
            # Setting 10s timeout on connect
            self.ws = await asyncio.wait_for(websockets.connect(self.ws_url), timeout=10.0)
            self.is_connected = True
            self.reconnect_attempts = 0
            
            # Send Auth immediately
            await self.send({
                "type": "auth_response",
                "api_key": self.api_key
            })
            
            # Start listener loop
            asyncio.create_task(self._listen_loop())
            
        except asyncio.TimeoutError:
            raise NetworkDisconnectError("WebSocket connection timeout", self.reconnect_attempts)
        except Exception as e:
            raise NetworkDisconnectError(f"WebSocket connection failed: {e}", self.reconnect_attempts, e)

    async def _listen_loop(self):
        try:
            async for message in self.ws:
                try:
                    msg = json.loads(message)
                    
                    if msg.get('type') == 'auth_success' or msg.get('event_type') == 'auth_success':
                        self.emit('authenticated', msg)
                    elif msg.get('type') == 'auth_failed':
                        logger.error("Authentication failed via WS")
                        self.emit('system_error', Exception("Authentication failed via WS"))
                    else:
                        self.emit('message', msg)
                except json.JSONDecodeError:
                    pass
        except websockets.exceptions.ConnectionClosed as e:
            self.is_connected = False
            self.emit('disconnect', e.code, e.reason)
            
            if not self.is_manually_closed:
                await self._attempt_reconnect()
        except Exception as e:
            self.emit('system_error', e)
            if not self.is_manually_closed:
                await self._attempt_reconnect()

    async def _attempt_reconnect(self):
        if self.reconnect_attempts >= self.max_reconnect_attempts:
            self.emit('terminal_disconnect', NetworkDisconnectError("Max WS reconnection attempts reached", self.reconnect_attempts))
            return

        self.reconnect_attempts += 1
        delay = min(3.0 * (2 ** (self.reconnect_attempts - 1)), 30.0)
        
        await asyncio.sleep(delay)
        
        if not self.is_manually_closed:
            try:
                await self.connect()
            except Exception:
                await self._attempt_reconnect()

    async def send(self, payload: Any):
        if self.ws and self.is_connected:
            await self.ws.send(json.dumps(payload))
        else:
            logger.warning("[AgentOTC SDK] Warning: Tried to send on disconnected WS. Payload dropped.")

    async def disconnect(self):
        self.is_manually_closed = True
        if self.ws:
            await self.ws.close()
            self.ws = None
            self.is_connected = False
