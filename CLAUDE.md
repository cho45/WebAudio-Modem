# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Communication Language

**日本語で会話してください** - Please communicate in Japanese when working with this project. The project owner is Japanese and prefers Japanese communication for better understanding and efficiency.

## Project Overview

WebAudio-Modem is a modern TypeScript implementation of audio modem functionality using the Web Audio API. The project provides complete FSK (Frequency Shift Keying) modulation and XModem transport protocol implementation for reliable data transmission over audio channels.

## Architecture Overview

The codebase implements a complete audio modem stack with three main layers:

### Physical Layer: FSK Modem (`src/modems/fsk.ts`)
- **FSKCore class**: Core FSK modulation/demodulation engine with I/Q detection
- **Mathematical precision**: Phase-continuous FSK with proper signal processing
- **Configurable parameters**: Mark/space frequencies, baud rates, filter characteristics
- **Signal quality monitoring**: SNR, BER, and other metrics

### Data Link Layer: XModem Transport (`src/transports/xmodem/`)
- **XModemPacket**: Packet creation, serialization, and parsing with CRC-16-CCITT
- **XModemTransport**: Complete Stop-and-Wait ARQ protocol with retransmission
- **Error handling**: Automatic packet loss detection and recovery
- **Data fragmentation**: Automatic splitting and reassembly of large data

### Core Infrastructure (`src/core.ts`)
- **Event system**: EventEmitter base class for all components
- **Interface definitions**: IModulator and ITransport for extensibility
- **Base classes**: Common functionality for modulators and transports

### Signal Processing (`src/dsp/filters.ts`, `src/utils/`)
- **Digital filters**: IIR/FIR lowpass, highpass, bandpass implementations
- **Buffer management**: RingBuffer for real-time audio streaming
- **CRC calculation**: CRC-16-CCITT for error detection

## Development Commands

```bash
# Testing
npm test                    # Run all tests (204 tests across 12 files)
npm run test:node          # Run Node.js tests only
npm run test:browser       # Run browser-specific tests

# Code Quality
npm run lint               # Run ESLint
npm run lint:fix           # Fix ESLint issues automatically

# Development
npm run dev                # Start Vite development server
npm run build              # Build for production
npm run preview            # Preview production build
```

### Running Specific Tests
```bash
# Test specific modules
npm test tests/modems/                          # FSK modem tests (70 tests)
npm test tests/transports/                     # XModem transport tests (51 tests)
npm test tests/core.node.test.ts              # Core infrastructure tests (21 tests)

# Test specific components
npm test tests/modems/fsk-modulation.node.test.ts     # FSK modulation only
npm test tests/transports/xmodem/xmodem.node.test.ts  # XModem protocol only
```

## Key Implementation Details

### FSK Signal Processing Architecture
The FSK implementation uses mathematically precise I/Q demodulation:
- **Envelope detection**: Hilbert transform for amplitude calculation
- **Digital filtering**: Cascaded IIR filters for signal conditioning
- **Bit synchronization**: State machine with Start Frame Delimiter (SFD) detection
- **Adaptive thresholds**: Dynamic adjustment based on signal characteristics

### XModem Protocol Implementation
Enhanced XModem with variable-length payloads:
- **Packet format**: SOH | SEQ | ~SEQ | LEN | PAYLOAD | CRC-16
- **Reliable delivery**: Stop-and-Wait ARQ with configurable timeouts and retries
- **Flow control**: Automatic back-pressure and acknowledgment handling
- **Transport abstraction**: High-level ITransport interface hides protocol complexity

### Current Implementation Status
- ✅ **FSK Modem**: Complete implementation with comprehensive testing
- ✅ **XModem Transport**: Full protocol with error recovery and fragmentation
- ✅ **Core Infrastructure**: Event system and base classes
- ✅ **Signal Processing**: Complete DSP toolkit
- ⚠️ **Audio Integration**: Interfaces ready, AudioWorklet implementation pending

## File Structure

```
src/
├── core.ts                          # Core interfaces and base classes
├── modems/fsk.ts                    # FSK modulation/demodulation engine
├── transports/xmodem/               # XModem protocol implementation
│   ├── packet.ts                    # Packet handling (create/parse/verify)
│   ├── types.ts                     # Type definitions and constants
│   └── xmodem.ts                    # Transport protocol with ARQ
├── dsp/filters.ts                   # Digital signal processing filters
├── utils/crc16.ts                   # CRC-16-CCITT implementation
└── utils.ts                         # RingBuffer and utilities

tests/                               # 241 Node.js tests + 12 browser tests
├── core.node.test.ts               # Event system tests (21 tests)
├── modems/                         # FSK modem tests (70 tests)
├── transports/xmodem/              # XModem protocol tests (51 tests)
├── dsp/                            # Signal processing tests (35 tests)
├── utils/                          # Utility tests (27 tests)
└── webaudio/                       # WebAudio integration tests (12 browser tests)
```

## Technical Standards

### Code Quality Requirements
- **TypeScript strict mode**: All code must pass strict type checking
- **100% test coverage**: All public APIs must have comprehensive tests
- **No ESLint errors**: Code must pass linting without exceptions
- **YAGNI principle**: Avoid unnecessary abstractions and premature optimization

### Testing Philosophy
- **Theoretical correctness**: Algorithms must be mathematically verified
- **Comprehensive coverage**: Test edge cases and boundary conditions
- **Root cause analysis**: Fix problems at source, never work around them
- **Real-world validation**: Test with actual audio signals when possible
- **Environment separation**: Node.js tests for pure logic, browser tests for Web API integration

### Browser Testing Strategy
Browser tests (`npm run test:browser`) are specifically designed to test **WebAudio API integration**:

**Purpose**: Test WebAudio-specific functionality that cannot be tested in Node.js
- AudioContext creation and lifecycle management
- AudioWorklet processor loading and message communication
- WebAudioModulatorNode integration with browser APIs
- XModemTransport integration with WebAudio components
- Graceful error handling in browser environments

**What NOT to test in browser**: 
- FSKCore modulation/demodulation (covered in Node.js tests)
- XModemPacket creation/parsing (covered in Node.js tests)  
- Signal processing algorithms (covered in Node.js tests)
- Mathematical correctness (covered in Node.js tests)

**Browser Test Environment**:
- Uses vitest with Playwright in headless Chromium
- Real AudioContext and AudioWorklet APIs available
- AudioWorklet processor loading succeeds via vite dev server
- 12 focused integration tests ensuring Web API compatibility

### Signal Processing Standards
- **Phase continuity**: FSK modulation must maintain phase coherence
- **Filter design**: Use proper digital filter theory (not approximations)
- **Numerical stability**: Handle edge cases in floating-point calculations
- **Performance optimization**: Minimize CPU usage while maintaining precision

## Legacy Code Notice

The `FSK/` directory contains legacy JavaScript implementation for reference only:
- **Do not extend or modify** legacy code
- **Use for algorithm reference** and validation only
- **Modern implementation** in `src/` supersedes all legacy functionality

## Development Guidelines

### When Adding New Features
1. **Design interfaces first**: Define TypeScript interfaces before implementation
2. **Write tests first**: Implement comprehensive test coverage
3. **Follow existing patterns**: Match the architectural style of current code
4. **Document signal processing**: Explain mathematical foundations in comments

### When Debugging
1. **Check test coverage**: Ensure the problem area has adequate tests
2. **Verify mathematical correctness**: Use test cases to validate algorithms
3. **Profile performance**: Use browser developer tools for optimization
4. **Test with real audio**: Validate against actual audio input/output

### When Modifying Core Components
- **EventEmitter**: Any changes require updating core.node.test.ts
- **FSKCore**: Modulation changes need comprehensive signal validation
- **XModemTransport**: Protocol changes must maintain backward compatibility
- **IModulator/ITransport**: Interface changes affect all implementations

## Future Extensibility

The architecture supports future modulation schemes:
- **PSK implementation**: Follow IModulator interface in `src/modems/psk.ts`
- **QAM implementation**: Use same pattern as FSK for complex modulation
- **New protocols**: Implement ITransport for additional transport protocols
- **AudioWorklet integration**: Ready for Web Audio API real-time processing

The codebase is production-ready for FSK modem applications and provides a solid foundation for extending to other modulation schemes.