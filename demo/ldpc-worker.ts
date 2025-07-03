import { LDPC, type HMatrixData } from '../src/fec/ldpc';

let ldpc: LDPC;

// Listen for messages from the main thread
self.onmessage = (e: MessageEvent) => {
    const { hMatrix, noisyLlr, maxIterations, chunkIndex } = e.data;

    // Initialize LDPC instance for the first time or if the matrix changes
    if (!ldpc || ldpc.getCodewordLength() !== hMatrix.width) {
        console.log('Worker: Initializing LDPC...');
        ldpc = new LDPC(hMatrix as HMatrixData);
    }

    // Perform the heavy decoding task
    const { decodedMessage, iterations, converged } = ldpc.decode(noisyLlr, maxIterations);

    // Send the result back to the main thread
    self.postMessage({
        decodedMessage,
        iterations,
        converged,
        chunkIndex
    });
};
