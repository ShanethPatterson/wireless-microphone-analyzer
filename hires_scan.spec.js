const HiResScan = require('./hires_scan.js')

describe('HiResScan.calculateSegments', () => {
    test('returns empty array for invalid inputs', () => {
        expect(HiResScan.calculateSegments(0, 0, 112, 112000)).toEqual([])
        expect(HiResScan.calculateSegments(1000, 500, 112, 112000)).toEqual([])
        expect(HiResScan.calculateSegments(0, 1000, 0, 112000)).toEqual([])
    })

    test('returns single segment when range fits in min span', () => {
        const segs = HiResScan.calculateSegments(470000000, 470100000, 112, 112000)
        expect(segs).toHaveLength(1)
        expect(segs[0].start).toBe(470000000)
        expect(segs[0].stop).toBe(470100000)
        expect(segs[0].pointOffset).toBe(0)
    })

    test('splits range into correct number of segments', () => {
        // 10 MHz range with 112 kHz min span = ~90 segments
        const startFreq = 470000000
        const stopFreq  = 480000000
        const segs = HiResScan.calculateSegments(startFreq, stopFreq, 112, 112000)

        expect(segs.length).toBeGreaterThan(1)
        expect(segs[0].start).toBe(startFreq)
        expect(segs[segs.length - 1].stop).toBe(stopFreq)
    })

    test('segments are contiguous (no gaps)', () => {
        const segs = HiResScan.calculateSegments(470000000, 480000000, 112, 112000)

        for (let i = 1; i < segs.length; i++) {
            expect(segs[i].start).toBe(segs[i - 1].stop)
        }
    })

    test('point offsets are sequential', () => {
        const nativePoints = 112
        const segs = HiResScan.calculateSegments(470000000, 480000000, nativePoints, 112000)

        for (let i = 0; i < segs.length; i++) {
            expect(segs[i].pointOffset).toBe(i * nativePoints)
        }
    })

    test('covers full range exactly', () => {
        const startFreq = 500000000
        const stopFreq  = 520000000
        const segs = HiResScan.calculateSegments(startFreq, stopFreq, 112, 112000)

        expect(segs[0].start).toBe(startFreq)
        expect(segs[segs.length - 1].stop).toBe(stopFreq)
    })

    test('works with larger min span', () => {
        // 20 MHz range with 2 MHz min span = 10 segments
        const segs = HiResScan.calculateSegments(470000000, 490000000, 112, 2000000)
        expect(segs).toHaveLength(10)
    })
})
