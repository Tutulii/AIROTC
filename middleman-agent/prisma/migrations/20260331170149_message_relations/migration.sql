-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
