// jam/qr-scanner.js — QR code scanner for easy Jam room joining.
//
// Uses device camera to scan host's QR code and auto-fill join form.
// Falls back gracefully if camera is unavailable.

import { parseInvite } from "../room.js";

/// Scan QR code using device camera
/// Returns { addr, code } on success, or throws on error/timeout
export async function scanQRCode(options = {}) {
  const {
    timeout = 30000,
    onFrame = null, // Optional callback for preview frames
  } = options;

  // Check if getUserMedia is available
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("Camera access not available in this browser");
  }

  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  let stream = null;
  let scanning = true;
  let timeoutId = null;

  try {
    // Request camera access (prefer environment/rear camera on mobile)
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      }
    });

    video.srcObject = stream;
    video.setAttribute('playsinline', 'true'); // iOS compatibility
    await video.play();

    return new Promise((resolve, reject) => {
      // Set up timeout
      timeoutId = setTimeout(() => {
        scanning = false;
        cleanup();
        reject(new Error('QR scan timeout after 30 seconds'));
      }, timeout);

      const scan = () => {
        if (!scanning) return;

        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          // Set canvas size to match video
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;

          // Draw current video frame to canvas
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          // Get image data
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

          // Call preview callback if provided
          if (onFrame) {
            onFrame(canvas);
          }

          // Try to decode QR code (using jsQR library)
          try {
            const code = decodeQR(imageData);
            if (code && code.data) {
              // Parse the invite text
              const invite = parseInvite(code.data);
              if (invite) {
                scanning = false;
                cleanup();
                resolve(invite);
                return;
              }
            }
          } catch (err) {
            // QR decode failed, continue scanning
          }
        }

        // Continue scanning
        if (scanning) {
          requestAnimationFrame(scan);
        }
      };

      // Start scanning loop
      scan();
    });
  } catch (err) {
    cleanup();
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      throw new Error('Camera permission denied');
    } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
      throw new Error('No camera found on this device');
    } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
      throw new Error('Camera is already in use by another application');
    } else {
      throw new Error(`Camera error: ${err.message}`);
    }
  }

  function cleanup() {
    if (timeoutId) clearTimeout(timeoutId);
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    if (video.srcObject) {
      video.srcObject = null;
    }
  }
}

/// Simple QR decoder (lightweight implementation)
/// For production, consider using jsQR library: npm install jsqr
function decodeQR(imageData) {
  // This is a placeholder - in real implementation, you would use jsQR:
  // import jsQR from 'jsqr';
  // return jsQR(imageData.data, imageData.width, imageData.height);

  // For now, return null (will be implemented when jsQR is added)
  // TODO: Add jsQR to package.json and import it
  return null;
}

/// Create a QR scanner UI overlay
export function createQRScannerUI(onScan, onCancel) {
  const overlay = document.createElement('div');
  overlay.className = 'qr-scanner-overlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.95);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
  `;

  const container = document.createElement('div');
  container.className = 'qr-scanner-container';
  container.style.cssText = `
    width: 90%;
    max-width: 400px;
    display: flex;
    flex-direction: column;
    gap: 1rem;
  `;

  // Preview canvas
  const preview = document.createElement('canvas');
  preview.className = 'qr-scanner-preview';
  preview.style.cssText = `
    width: 100%;
    border-radius: 1rem;
    border: 2px solid #667eea;
  `;

  // Scanning frame overlay
  const frame = document.createElement('div');
  frame.className = 'qr-scanner-frame';
  frame.style.cssText = `
    position: absolute;
    width: 250px;
    height: 250px;
    border: 3px solid #667eea;
    border-radius: 1rem;
    box-shadow: 0 0 0 9999px rgba(0, 0, 0, 0.5);
  `;

  // Status text
  const status = document.createElement('div');
  status.className = 'qr-scanner-status';
  status.textContent = 'Point camera at QR code';
  status.style.cssText = `
    color: white;
    text-align: center;
    font-size: 1rem;
    margin-top: 1rem;
  `;

  // Cancel button
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = `
    padding: 0.75rem 2rem;
    background: #ef4444;
    color: white;
    border: none;
    border-radius: 0.5rem;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    margin-top: 1rem;
  `;
  cancelBtn.addEventListener('click', () => {
    document.body.removeChild(overlay);
    if (onCancel) onCancel();
  });

  container.appendChild(preview);
  container.appendChild(status);
  container.appendChild(cancelBtn);
  overlay.appendChild(frame);
  overlay.appendChild(container);

  // Start scanning
  scanQRCode({
    onFrame: (canvas) => {
      // Update preview
      const ctx = preview.getContext('2d');
      preview.width = canvas.width;
      preview.height = canvas.height;
      ctx.drawImage(canvas, 0, 0);
    }
  })
    .then((invite) => {
      document.body.removeChild(overlay);
      if (onScan) onScan(invite);
    })
    .catch((err) => {
      status.textContent = `Error: ${err.message}`;
      status.style.color = '#ef4444';
      setTimeout(() => {
        if (document.body.contains(overlay)) {
          document.body.removeChild(overlay);
        }
        if (onCancel) onCancel();
      }, 3000);
    });

  document.body.appendChild(overlay);
  return overlay;
}
