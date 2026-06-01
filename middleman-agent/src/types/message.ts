export interface Message {
  message_id: string;
  ticket_id: string;
  sender: string;
  senderWallet?: string;
  content: string;
  timestamp: string;
}
