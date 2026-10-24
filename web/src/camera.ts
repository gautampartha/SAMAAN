// Shared rear-camera preview + frame grab, used by the capture page and the
// report sheet. `getUserMedia` needs a secure context; otherwise `state` is
// 'fallback' and callers show an <input type="file" capture="environment">.
import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraState = 'starting' | 'live' | 'fallback' | 'off';

export const JPEG_QUALITY = 0.85;

export function getUserMediaAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    (typeof window === 'undefined' || window.isSecureContext)
  );
}

export function canvasToJpeg(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), 'image/jpeg', JPEG_QUALITY);
  });
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bmp = await createImageBitmap(blob);
    const size = { width: bmp.width, height: bmp.height };
    bmp.close();
    return size;
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('image decode failed'));
    };
    img.src = url;
  });
}

export interface Frame {
  blob: Blob;
  width: number;
  height: number;
}

export interface Camera {
  /** Attach to a <video playsInline muted autoPlay>. */
  videoRef: React.RefObject<HTMLVideoElement>;
  state: CameraState;
  /** `${name}: ${message}` of the getUserMedia failure, when any. */
  error: string | null;
  /** Current preview frame as JPEG; rejects when the preview is not live yet. */
  grabFrame: () => Promise<Frame>;
}

/** Start the rear camera while `active` is true; stop it (and release the tracks) when it turns false. */
export function useCamera(active: boolean): Camera {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>('off');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      setState('off');
      return;
    }
    if (!getUserMediaAvailable()) {
      setState('fallback');
      return;
    }
    let cancelled = false;
    setState('starting');
    setError(null);
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.muted = true;
          video.srcObject = stream;
          video.play().catch(() => undefined);
        }
        setState('live');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
        setState('fallback');
      });
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
      const video = videoRef.current;
      if (video) video.srcObject = null;
    };
  }, [active]);

  const grabFrame = useCallback(async (): Promise<Frame> => {
    const video = videoRef.current;
    if (!video || !streamRef.current) throw new Error('camera not live');
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error('video has no frame yet');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(video, 0, 0, width, height);
    const blob = await canvasToJpeg(canvas);
    return { blob, width, height };
  }, []);

  return { videoRef, state, error, grabFrame };
}
