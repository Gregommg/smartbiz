import { useEffect, useRef, useState } from 'react'

// Camera barcode scanning uses the browser's BarcodeDetector (Chrome on Android and desktop). Other browsers: use a USB/Bluetooth scanner or type the code.
export const canScan = typeof window !== 'undefined' && 'BarcodeDetector' in window
export function Scanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null); const [err, setErr] = useState('')
  useEffect(() => {
    let stop = false, stream: MediaStream | null = null, timer = 0
    ;(async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        if (stop) return stream.getTracks().forEach(t => t.stop())
        video.current!.srcObject = stream; await video.current!.play()
        const det = new (window as any).BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] })
        const tick = async () => { try { const r = await det.detect(video.current!); if (r[0]?.rawValue) { onCode(r[0].rawValue); return } } catch { /* keep trying */ } if (!stop) timer = window.setTimeout(tick, 300) }
        tick()
      } catch { setErr('Could not open the camera. Allow camera access in your browser, or type the code.') }
    })()
    return () => { stop = true; clearTimeout(timer); stream?.getTracks().forEach(t => t.stop()) }
  }, [onCode])
  return <div className="scrim"><div className="sheet"><h2>Scan a barcode</h2>{err ? <p className="err">{err}</p> : <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 8, background: '#000' }} />}<button className="btn alt" onClick={onClose}>Close</button></div></div>
}
