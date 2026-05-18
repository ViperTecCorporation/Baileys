import { Boom } from '@hapi/boom';
import type { MessageRelayOptions, WAMessage } from '../Types/index.js';
export type RetryableSendPayload = {
    targetJid: string;
    fullMessage: WAMessage;
    relayOptions: MessageRelayOptions;
};
export type RetryableStaleConnectionError = Boom & {
    data: {
        staleConnection: true;
        retryAfterReconnect: true;
        retriable: true;
        retryableSend?: RetryableSendPayload;
    };
};
export declare const isRetryableStaleConnectionError: (error: unknown) => error is RetryableStaleConnectionError;
export declare const getRetryableSendPayload: (error: unknown) => any;
export declare const retrySendAfterReconnect: (socket: {
    relayMessage: (jid: string, message: NonNullable<WAMessage["message"]>, options: MessageRelayOptions) => Promise<string>;
}, error: unknown) => Promise<string>;
//# sourceMappingURL=retryable-send.d.ts.map