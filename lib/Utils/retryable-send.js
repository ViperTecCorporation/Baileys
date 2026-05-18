import { Boom } from '@hapi/boom';
import { DisconnectReason } from '../Types/index.js';
export const isRetryableStaleConnectionError = (error) => {
    if (!(error instanceof Boom)) {
        return false;
    }
    return (error.output?.statusCode === DisconnectReason.connectionLost &&
        error.data?.staleConnection === true &&
        error.data?.retryAfterReconnect === true);
};
export const getRetryableSendPayload = (error) => {
    if (!isRetryableStaleConnectionError(error)) {
        return undefined;
    }
    return error.data?.retryableSend;
};
export const retrySendAfterReconnect = async (socket, error) => {
    const payload = getRetryableSendPayload(error);
    if (!payload?.fullMessage.message) {
        throw error;
    }
    return socket.relayMessage(payload.targetJid, payload.fullMessage.message, payload.relayOptions);
};
//# sourceMappingURL=retryable-send.js.map