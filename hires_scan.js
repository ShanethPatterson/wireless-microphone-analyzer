'use strict'

const { Subject, firstValueFrom } = require('rxjs')
const { filter, timeout } = require('rxjs/operators')

// Delay between HOLD command and next setConfiguration to let device settle
const SEGMENT_SETTLE_DELAY_MS = 150
// How many sweeps to collect per segment before moving on (peak of these is kept)
const SWEEPS_PER_SEGMENT = 2
// Timeout waiting for a sweep response
const SWEEP_TIMEOUT_MS = 5000

class HiResScan {
    constructor () {
        this.active = false
        this.segments = []
        this.compositeData = []
        this.compositeFreqs = []
        this.totalPoints = 0
        this.currentSegment = 0
        this.sweepCount = 0
        this.onComplete = null  // callback(compositeData, compositeFreqs, totalPoints)
        this.onProgress = null  // callback(currentSegment, totalSegments)
        this.aborted = false
    }

    /**
     * Calculate sub-range segments for high-res scanning.
     * Splits the total range into segments, each scanned at native point resolution.
     *
     * @param {number} startFreq  - Start frequency in Hz
     * @param {number} stopFreq   - Stop frequency in Hz
     * @param {number} nativePoints - Points per sweep (e.g. 112 for RF Explorer BASIC)
     * @param {number} minSpan    - Minimum span the device supports in Hz
     * @returns {Array} Array of { start, stop, pointOffset } segment descriptors
     */
    static calculateSegments (startFreq, stopFreq, nativePoints, minSpan) {
        const totalSpan = stopFreq - startFreq

        if ( totalSpan <= 0 || nativePoints <= 0 ) {
            return []
        }

        // If the total span fits in a single sweep, no segmentation needed
        if ( totalSpan <= minSpan ) {
            return [{
                start: startFreq,
                stop: stopFreq,
                pointOffset: 0
            }]
        }

        // Each segment covers the native resolution worth of span
        // Use minSpan as the segment width since that gives max resolution per segment
        const segmentSpan = Math.max(minSpan, totalSpan / Math.ceil(totalSpan / minSpan))
        const numSegments = Math.ceil(totalSpan / segmentSpan)
        const segments = []
        let pointOffset = 0

        for ( let i = 0; i < numSegments; i++ ) {
            const segStart = startFreq + (i * segmentSpan)
            const segStop = Math.min(segStart + segmentSpan, stopFreq)

            segments.push({
                start: Math.round(segStart),
                stop: Math.round(segStop),
                pointOffset: pointOffset
            })

            pointOffset += nativePoints
        }

        return segments
    }

    /**
     * Start a high-res scan cycle.
     *
     * @param {object} scanDevice  - RFExplorer or TinySA device instance
     * @param {Subject} data$      - RxJS Subject carrying scan data events
     * @param {number} startFreq   - Start frequency in Hz
     * @param {number} stopFreq    - Stop frequency in Hz
     * @param {number} nativePoints - Points per native sweep
     * @param {number} minSpan     - Minimum device span in Hz
     * @param {Function} convertValueFn - Function to convert raw scan value to dBm
     * @param {string} deviceType  - 'RF_EXPLORER' or 'TINY_SA'
     */
    async start (scanDevice, data$, startFreq, stopFreq, nativePoints, minSpan, convertValueFn, deviceType) {
        this.segments = HiResScan.calculateSegments(startFreq, stopFreq, nativePoints, minSpan)

        if ( this.segments.length <= 1 ) {
            log.info('HiRes: Range fits in a single sweep, hi-res not needed')
            return false
        }

        this.active = true
        this.aborted = false
        this.totalPoints = this.segments.length * nativePoints
        this.compositeData = new Array(this.totalPoints).fill(undefined)
        this.compositeFreqs = new Array(this.totalPoints)
        this.currentSegment = 0

        // Pre-calculate frequency labels for composite
        for ( let i = 0; i < this.segments.length; i++ ) {
            const seg = this.segments[i]
            const segStep = (seg.stop - seg.start) / (nativePoints - 1)
            for ( let j = 0; j < nativePoints; j++ ) {
                this.compositeFreqs[seg.pointOffset + j] = Math.round(seg.start + (j * segStep))
            }
        }

        log.info(`HiRes: Starting scan with ${this.segments.length} segments, ${this.totalPoints} total points`)
        log.info(`HiRes: Segment span: ${((this.segments[0].stop - this.segments[0].start) / 1000000).toFixed(3)} MHz`)

        await this._scanLoop(scanDevice, data$, nativePoints, convertValueFn, deviceType)
        return true
    }

    stop () {
        log.info('HiRes: Stopping scan')
        this.active = false
        this.aborted = true
    }

    isActive () {
        return this.active
    }

    getResults () {
        return {
            data: this.compositeData,
            freqs: this.compositeFreqs,
            totalPoints: this.totalPoints,
            segments: this.segments.length
        }
    }

    async _scanLoop (scanDevice, data$, nativePoints, convertValueFn, deviceType) {
        while ( this.active && !this.aborted ) {
            for ( let segIdx = 0; segIdx < this.segments.length; segIdx++ ) {
                if ( !this.active || this.aborted ) break

                this.currentSegment = segIdx
                const seg = this.segments[segIdx]

                if ( this.onProgress ) {
                    this.onProgress(segIdx, this.segments.length)
                }

                try {
                    // For RF Explorer: send HOLD to stop current stream, wait, then reconfigure
                    if ( deviceType === 'RF_EXPLORER' && scanDevice.hold ) {
                        await scanDevice.hold()
                        await this._delay(SEGMENT_SETTLE_DELAY_MS)
                    }

                    // Configure device for this segment's frequency range
                    await scanDevice.setConfiguration(seg.start, seg.stop, nativePoints)

                    // Collect sweeps for this segment
                    for ( let sweep = 0; sweep < SWEEPS_PER_SEGMENT; sweep++ ) {
                        if ( !this.active || this.aborted ) break

                        try {
                            const scanData = await firstValueFrom(
                                data$.pipe(
                                    filter(d => d[0].type === 'SCAN_DATA'),
                                    timeout(SWEEP_TIMEOUT_MS)
                                )
                            )

                            // Store peak values into composite buffer
                            const values = scanData[0].values
                            for ( let i = 0; i < values.length && i < nativePoints; i++ ) {
                                const dbm = convertValueFn(values[i])
                                const compositeIdx = seg.pointOffset + i
                                const existing = this.compositeData[compositeIdx]

                                if ( existing === undefined || dbm > existing ) {
                                    this.compositeData[compositeIdx] = dbm
                                }
                            }
                        } catch (err) {
                            log.warn(`HiRes: Sweep timeout on segment ${segIdx}, sweep ${sweep}`)
                        }
                    }
                } catch (err) {
                    log.error(`HiRes: Error on segment ${segIdx}: ${err}`)
                    if ( !this.active ) break
                    // Continue to next segment on error
                }
            }

            // Full cycle complete — emit results
            if ( this.active && !this.aborted && this.onComplete ) {
                log.info('HiRes: Full scan cycle complete')
                this.onComplete(this.compositeData.slice(), this.compositeFreqs, this.totalPoints)
            }

            // Reset composite for next cycle (allow new peaks)
            if ( this.active && !this.aborted ) {
                this.compositeData = new Array(this.totalPoints).fill(undefined)
            }
        }

        this.active = false
    }

    _delay (ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }
}

module.exports = HiResScan
