import type { ILogger } from '../Utils/logger.js';
import { type BinaryNode } from '../WABinary/index.js';
import { BinaryInfo } from './BinaryInfo.js';
type WamProps = Record<string, number | string | null>;
type SendWAMBuffer = (wamBuffer: Buffer) => Promise<unknown>;
export type WamTelemetryOptions = {
    enabled?: boolean;
    debugEvents?: boolean;
    flushIntervalMs?: number;
    maxEvents?: number;
};
export declare const resolveWamTelemetryOptions: (options?: WamTelemetryOptions) => Required<WamTelemetryOptions>;
export declare class WamTelemetry {
    private readonly buffer;
    private readonly sendWAMBuffer;
    private readonly logger;
    private readonly enabled;
    private readonly debugEvents;
    private readonly flushIntervalMs;
    private readonly maxEvents;
    private readonly sentMessages;
    private timer;
    private flushing;
    private streamMode;
    private connectedOnce;
    private resumeCount;
    constructor(buffer: BinaryInfo, sendWAMBuffer: SendWAMBuffer, logger: ILogger, options?: WamTelemetryOptions);
    get isEnabled(): boolean;
    commit(name: string, props?: WamProps): void;
    onConnectionOpen(): void;
    onConnectionClose(): void;
    onOfflineComplete(): void;
    onNodeOut(node: BinaryNode): void;
    onNodeIn(node: BinaryNode, handled: boolean): void;
    onHistorySync(syncType?: number, progress?: number): void;
    flush(): Promise<void>;
    dispose(): void;
    private onIncomingMessage;
    private onIncomingReceipt;
    private onIncomingAck;
    private setStreamMode;
    private scheduleFlush;
    private trackSend;
}
export {};
//# sourceMappingURL=telemetry.d.ts.map