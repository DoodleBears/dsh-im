/** A full-reception callback is addressed only by its normalized top-level self mention. */
export function isQqAddressedGroupMessage(message) {
  return message?.kind === 'group' && (message.rawEventType === 'GROUP_AT_MESSAGE_CREATE'
    || (message.rawEventType === 'GROUP_MESSAGE_CREATE' && Array.isArray(message.mentions)
      && message.mentions.some(mention => mention?.is_you === true)));
}

/** A private (C2C) message is always addressed to the receiving application. */
export function isQqDirectMessage(message) {
  return message?.kind === 'c2c' && message.rawEventType === 'C2C_MESSAGE_CREATE';
}

export function isQqAddressedMessage(message) {
  return isQqAddressedGroupMessage(message) || isQqDirectMessage(message);
}
