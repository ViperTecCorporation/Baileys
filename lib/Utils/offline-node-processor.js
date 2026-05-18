/**
 * Creates a processor for offline stanza nodes that:
 * - Queues nodes for sequential processing
 * - Yields to the event loop periodically to avoid blocking
 * - Catches handler errors to prevent the processing loop from crashing
 */
export function makeOfflineNodeProcessor(nodeProcessorMap, deps, batchSize = 10) {
    const nodes = [];
    let isProcessing = false;
    const enqueue = (type, node) => {
        nodes.push({ type, node });
        if (isProcessing) {
            return;
        }
        isProcessing = true;
        const promise = async () => {
            let processedInBatch = 0;
            while (nodes.length && deps.isWsOpen()) {
                const { type: queuedType, node: queuedNode } = nodes.shift();
                const nodeProcessor = nodeProcessorMap.get(queuedType);
                if (!nodeProcessor) {
                    deps.onUnexpectedError(new Error(`unknown offline node type: ${queuedType}`), 'processing offline node');
                    continue;
                }
                await nodeProcessor(queuedNode).catch(err => deps.onUnexpectedError(err, `processing offline ${queuedType}`));
                processedInBatch++;
                if (processedInBatch >= batchSize) {
                    processedInBatch = 0;
                    await deps.yieldToEventLoop();
                }
            }
            isProcessing = false;
        };
        promise().catch(error => deps.onUnexpectedError(error, 'processing offline nodes'));
    };
    return { enqueue };
}
//# sourceMappingURL=offline-node-processor.js.map