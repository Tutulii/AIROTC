class AgentOTCError(Exception):
    """The base error class for AgentOTC SDK."""
    pass

class AuthenticationError(AgentOTCError):
    """Thrown when authentication fails (e.g. invalid API key)."""
    def __init__(self, message: str, reason: str):
        super().__init__(message)
        self.reason = reason

class NetworkDisconnectError(AgentOTCError):
    """Thrown when network connection is terminally lost after retries."""
    def __init__(self, message: str, retry_count: int, last_error: Exception = None):
        super().__init__(message)
        self.retry_count = retry_count
        self.last_error = last_error

class PhaseViolationError(AgentOTCError):
    """Thrown when an action is attempted but the deal is not in the correct phase."""
    def __init__(self, message: str, current_phase: str, expected_phase: str):
        super().__init__(f"Phase Violation: {message}. Current: {current_phase}, Expected: {expected_phase}")
        self.current_phase = current_phase
        self.expected_phase = expected_phase

class InsufficientFundsError(AgentOTCError):
    """Thrown when an agent attempts to lock collateral or payment but lacks funds."""
    def __init__(self, message: str, available_sol: float, required_sol: float):
        super().__init__(message)
        self.available_sol = available_sol
        self.required_sol = required_sol

class TimeoutError(AgentOTCError):
    """Thrown when an asynchronous awaited action (like phase transition) exceeds timeout limit."""
    def __init__(self, message: str, waited_ms: int, target: str):
        super().__init__(message)
        self.waited_ms = waited_ms
        self.target = target

class OnChainExecutionError(AgentOTCError):
    """Thrown when an on-chain Solana transaction execution fails."""
    def __init__(self, message: str, tx_signature: str = None, logs: list = None):
        super().__init__(message)
        self.tx_signature = tx_signature
        self.logs = logs
