export function isBotSenderType(sender) {
  return sender?.sender_type === 'app' || sender?.sender_type === 'bot';
}

export function sourceSenderMatches(sender, actorId) {
  if (sender?.sender_type === 'user') return sender.id_type === 'open_id' && sender.id === actorId;
  return isBotSenderType(sender) && typeof sender.id === 'string' && sender.id.length > 0;
}
