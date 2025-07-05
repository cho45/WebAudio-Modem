import { LDPC, type HMatrixData } from '../src/fec/ldpc';
import ldpcMatrix128 from '../src/fec/ldpc_h_matrix_n128_k64.json';
import ldpcMatrix256 from '../src/fec/ldpc_h_matrix_n256_k128.json';
import ldpcMatrix512 from '../src/fec/ldpc_h_matrix_n512_k256.json';
import ldpcMatrix1024 from '../src/fec/ldpc_h_matrix_n1024_k512.json';

// --- DOM Elements ---
const matrixSelect = document.getElementById('matrix-select') as HTMLSelectElement;
const errorSlider = document.getElementById('error-slider') as HTMLInputElement;
const iterationsInput = document.getElementById('iterations-input') as HTMLInputElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;

const originalCanvas = document.getElementById('original-canvas') as HTMLCanvasElement;
const noisyCanvas = document.getElementById('noisy-canvas') as HTMLCanvasElement;
const decodedCanvas = document.getElementById('decoded-canvas') as HTMLCanvasElement;
const hMatrixCanvas = document.getElementById('h-matrix-canvas') as HTMLCanvasElement;
const llrCanvas = document.getElementById('llr-canvas') as HTMLCanvasElement;

const statusBox = document.getElementById('status-box') as HTMLDivElement;
const progressContainer = document.getElementById('progress-container') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLDivElement;


// --- H-Matrix Data ---
const hMatrices: { [key: string]: HMatrixData } = {
  '128': ldpcMatrix128 as HMatrixData,
  '256': ldpcMatrix256 as HMatrixData,
  '512': ldpcMatrix512 as HMatrixData,
  '1024': ldpcMatrix1024 as HMatrixData,
};

// --- State ---
let ldpc: LDPC;
let currentMatrix: HMatrixData;
let originalImageData: Uint8ClampedArray;

// --- Helper & Visualization Functions ---

function drawHMatrix(matrix: HMatrixData) {
  const ctx = hMatrixCanvas.getContext('2d')!;
  const width = hMatrixCanvas.width;
  const height = hMatrixCanvas.height;
  const cellWidth = width / matrix.width;
  const cellHeight = height / matrix.height;

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#333';
  for (const conn of matrix.connections) {
    ctx.fillRect(conn.bit * cellWidth, conn.check * cellHeight, Math.max(1, cellWidth), Math.max(1, cellHeight));
  }
}

function drawLLR(llr: Int8Array | Float32Array) {
  const ctx = llrCanvas.getContext('2d')!;
  const width = llrCanvas.width;
  const height = llrCanvas.height;
  
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(0, 0, width, height);

  const barWidth = width / llr.length;
  for (let i = 0; i < llr.length; i++) {
    const value = llr[i];
    const barHeight = Math.min(height / 2, Math.abs(value / 127) * (height / 2));
    ctx.fillStyle = value >= 0 ? '#007aff' : '#ff3b30';
    ctx.fillRect(i * barWidth, height / 2, barWidth, -barHeight);
  }
}

function drawImageFromGrayscale(canvas: HTMLCanvasElement, grayscaleData: Uint8ClampedArray) {
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < grayscaleData.length; i++) {
        const g = grayscaleData[i];
        imageData.data[i * 4] = g;
        imageData.data[i * 4 + 1] = g;
        imageData.data[i * 4 + 2] = g;
        imageData.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
}

function countSetBits(n: number): number {
    let count = 0;
    while (n > 0) {
        n &= (n - 1);
        count++;
    }
    return count;
}

function introduceErrors(codeword: Uint8Array, numErrors: number): Uint8Array {
  if (numErrors === 0) return codeword;
  const noisyCodeword = new Uint8Array(codeword);
  const bitLength = codeword.length * 8;
  const errorPositions = new Set<number>();

  while (errorPositions.size < numErrors && errorPositions.size < bitLength) {
    const pos = Math.floor(Math.random() * bitLength);
    errorPositions.add(pos);
  }

  for (const pos of errorPositions) {
    const byteIndex = Math.floor(pos / 8);
    const bitIndex = pos % 8;
    noisyCodeword[byteIndex] ^= (1 << (7 - bitIndex));
  }
  return noisyCodeword;
}

function bitsToLlr(noisyCodeword: Uint8Array, originalCodeword: Uint8Array): Int8Array {
    const llr = new Int8Array(noisyCodeword.length * 8);
    for (let i = 0; i < llr.length; i++) {
        const noisyBit = (noisyCodeword[i >> 3] >> (7 - (i % 8))) & 1;
        const originalBit = (originalCodeword[i >> 3] >> (7 - (i % 8))) & 1;
        const isError = noisyBit !== originalBit;

        let baseLlr;
        if (isError) {
            baseLlr = noisyBit === 0 ? 30 : -30;
        } else {
            baseLlr = noisyBit === 0 ? 100 : -100;
        }
        const noise = (Math.random() - 0.5) * 20;
        llr[i] = Math.max(-127, Math.min(127, baseLlr + noise));
    }
    return llr;
}

function reconstructImage(messageChunks: (Uint8Array | null)[]): Uint8ClampedArray {
    if (!originalImageData || !ldpc) throw new Error("Not initialized");
    const grayscale = new Uint8ClampedArray(originalImageData.length);
    let bitPosition = 0;

    for (const chunk of messageChunks) {
        if (!chunk) continue;
        for (let i = 0; i < ldpc.getMessageLength(); i++) {
            if (bitPosition >= grayscale.length * 8) break;
            const bit = (chunk[i >> 3] >> (7 - (i % 8))) & 1;
            if (bit) {
                grayscale[bitPosition >> 3] |= (1 << (7 - (bitPosition % 8)));
            }
            bitPosition++;
        }
    }
    return grayscale;
}

/**
 * A helper function to wrap worker communication in a Promise for clean async/await usage.
 * @param worker The worker instance.
 * @param jobData The data to post to the worker.
 * @returns A promise that resolves with the worker's result.
 */
function processChunkInWorker(worker: Worker, jobData: any): Promise<any> {
    return new Promise((resolve, reject) => {
        const messageHandler = (e: MessageEvent) => {
            if (e.data.type === 'decode_result' && e.data.chunkIndex === jobData.chunkIndex) {
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                resolve(e.data);
            }
        };

        const errorHandler = (err: ErrorEvent) => {
            worker.removeEventListener('message', messageHandler);
            worker.removeEventListener('error', errorHandler);
            reject(err);
        };

        worker.addEventListener('message', messageHandler);
        worker.addEventListener('error', errorHandler);

        worker.postMessage(jobData);
    });
}

// --- Main Logic ---

async function runSimulation() {
    if (!originalImageData || !ldpc) {
        statusBox.textContent = 'Error: Image or LDPC not initialized.';
        return;
    }

    runBtn.disabled = true;
    statusBox.textContent = 'Preparing data...';
    progressContainer.style.display = 'block';
    progressBar.style.width = '0%';
    progressBar.textContent = '0%';

    await new Promise(resolve => setTimeout(resolve, 10));

    const messageBitLength = originalImageData.length * 8;
    const messageLengthPerChunk = ldpc.getMessageLength();
    const numChunks = Math.ceil(messageBitLength / messageLengthPerChunk);
    const numErrorsPerChunk = parseInt(errorSlider.value, 10);
    const maxIterations = parseInt(iterationsInput.value, 10);

    // --- 1. Create Visually Noisy Image for Display ---
    const noisyImageDataForDisplay = new Uint8ClampedArray(originalImageData);
    const codeRate = ldpc.getCodeRate();
    const totalErrorsToDisplay = Math.floor(numErrorsPerChunk * numChunks * codeRate);
    const errorPositions = new Set<number>();
    while (errorPositions.size < totalErrorsToDisplay && errorPositions.size < messageBitLength) {
        const pos = Math.floor(Math.random() * messageBitLength);
        errorPositions.add(pos);
    }
    for (const pos of errorPositions) {
        const byteIndex = Math.floor(pos / 8);
        noisyImageDataForDisplay[byteIndex] ^= (1 << (7 - (pos % 8)));
    }
    drawImageFromGrayscale(noisyCanvas, noisyImageDataForDisplay);
    drawImageFromGrayscale(decodedCanvas, new Uint8ClampedArray(originalImageData.length).fill(128));

    // --- 2. Prepare all chunks for processing ---
    const processingQueue: any[] = [];
    for (let i = 0; i < numChunks; i++) {
        const chunkStartBit = i * messageLengthPerChunk;
        const messageChunk = new Uint8Array(Math.ceil(messageLengthPerChunk / 8));
        for (let b = 0; b < messageLengthPerChunk; b++) {
            const bitPos = chunkStartBit + b;
            if (bitPos >= messageBitLength) break;
            const bit = (originalImageData[bitPos >> 3] >> (7 - (bitPos % 8))) & 1;
            if (bit) {
                messageChunk[b >> 3] |= (1 << (7 - (b % 8)));
            }
        }
        const encoded = ldpc.encode(messageChunk);
        const noisyCodeword = introduceErrors(encoded, numErrorsPerChunk);
        const noisyLlr = bitsToLlr(noisyCodeword, encoded);
        processingQueue.push({ chunkIndex: i, noisyLlr });
    }
    drawLLR(processingQueue[0].noisyLlr);

    // --- 3. Process chunks serially using a single worker with async/await ---
    statusBox.textContent = `Decoding ${numChunks} chunks serially...`;
    const worker = new Worker(new URL('./ldpc-worker.ts', import.meta.url), { type: 'module' });
    
    const decodedMessageChunks: (Uint8Array | null)[] = new Array(numChunks).fill(null);
    let chunksProcessed = 0;
    let totalConverged = 0;
    let totalIterations = 0;

    const hMatrixForWorker = { 
        height: currentMatrix.height, 
        width: currentMatrix.width, 
        connections: currentMatrix.connections 
    };

    try {
        // Initialize the worker with the H-Matrix
        statusBox.textContent = 'Initializing worker with H-Matrix...';
        await new Promise<void>((resolve, reject) => {
            const initMessageHandler = (e: MessageEvent) => {
                if (e.data.type === 'init_complete') {
                    worker.removeEventListener('message', initMessageHandler);
                    resolve();
                }
            };
            const initErrorHandler = (err: ErrorEvent) => {
                worker.removeEventListener('message', initMessageHandler);
                reject(err);
            };
            worker.addEventListener('message', initMessageHandler);
            worker.addEventListener('error', initErrorHandler);
            worker.postMessage({ type: 'init', hMatrix: hMatrixForWorker });
        });

        statusBox.textContent = `Decoding ${numChunks} chunks serially...`;
        for (const job of processingQueue) {
            const result = await processChunkInWorker(worker, {
                type: 'decode',
                noisyLlr: job.noisyLlr,
                maxIterations,
                chunkIndex: job.chunkIndex
            });

            decodedMessageChunks[result.chunkIndex] = result.decodedMessage;
            if (result.converged) totalConverged++;
            totalIterations += result.iterations;
            chunksProcessed++;

            const progress = Math.round((chunksProcessed / numChunks) * 100);
            progressBar.style.width = `${progress}%`;
            progressBar.textContent = `${progress}%`;
        }

        // --- 4. All chunks processed, finalize ---
        const reconstructedGrayscale = reconstructImage(decodedMessageChunks);
        drawImageFromGrayscale(decodedCanvas, reconstructedGrayscale);

        const originalBytes = new Uint8Array(originalImageData.buffer);
        const reconstructedBytes = new Uint8Array(reconstructedGrayscale.buffer);
        let finalErrorBits = 0;
        for (let j = 0; j < originalBytes.length; j++) {
            finalErrorBits += countSetBits(originalBytes[j] ^ reconstructedBytes[j]);
        }

        const success = finalErrorBits === 0;
        statusBox.style.backgroundColor = success ? '#d4edda' : '#f8d7da';
        statusBox.innerHTML = `
            <strong>Status: ${success ? 'Success!' : 'Failure'}</strong><br>
            ${finalErrorBits} incorrect bits remaining in the image.<br>
            ${totalConverged} out of ${numChunks} chunks converged (avg. ${ (totalIterations / numChunks).toFixed(1) } iterations).
        `;

    } catch (err) {
        console.error(`Worker processing failed:`, err);
        statusBox.textContent = `An error occurred during decoding. See console for details.`;
    } finally {
        worker.terminate();
        runBtn.disabled = false;
    }
}

// --- UI & Initial Setup ---

function updateConfig() {
  const matrixSize = matrixSelect.value;
  currentMatrix = hMatrices[matrixSize];
  ldpc = new LDPC(currentMatrix);

  const codewordLength = ldpc.getCodewordLength();
  errorSlider.max = String(Math.floor(codewordLength / 4));
  errorSlider.value = Math.min(parseInt(errorSlider.value, 10), parseInt(errorSlider.max, 10)).toString();

  llrCanvas.width = ldpc.getCodewordLength();
  hMatrixCanvas.width = currentMatrix.width;
  hMatrixCanvas.height = currentMatrix.height;

  drawHMatrix(currentMatrix);
}

async function loadImage() {
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.src = '/sample-files/original.png';
    await new Promise((resolve, reject) => { 
        img.onload = resolve;
        img.onerror = reject;
    });

    const ctx = originalCanvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, originalCanvas.width, originalCanvas.height);
    const imageData = ctx.getImageData(0, 0, originalCanvas.width, originalCanvas.height);
    
    const grayscale = new Uint8ClampedArray(imageData.width * imageData.height);
    for (let i = 0; i < grayscale.length; i++) {
        const r = imageData.data[i * 4];
        const g = imageData.data[i * 4 + 1];
        const b = imageData.data[i * 4 + 2];
        grayscale[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
    originalImageData = grayscale;
    drawImageFromGrayscale(originalCanvas, originalImageData);
    statusBox.textContent = 'Image loaded. Select parameters and run simulation.';
}

// --- Event Listeners ---
matrixSelect.addEventListener('change', updateConfig);
runBtn.addEventListener('click', runSimulation);

// --- Initializer ---
window.addEventListener('load', async () => {
    try {
        runBtn.disabled = true;
        statusBox.textContent = 'Loading image...';
        await loadImage();
        updateConfig();
        runBtn.disabled = false;
    } catch (err) {
        statusBox.textContent = 'Error loading image. Please check console.';
        console.error("Failed to load image:", err);
    }
});
