/** A full-reception callback is addressed only by its normalized top-level self mention. */
export function isQqAddressedGroupMessage(message) {
  return message?.kind === 'group' && (message.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
    || (message.rawEventType === 'GROUP_MESSAGE_CREATE' && Array.isArray(message.mentions)
      && message.mentions.some(mention => mention?.is_you === true)));
}
