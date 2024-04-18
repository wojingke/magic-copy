import { Tensor } from "onnxruntime-web";
import React from "react";
import { traceOnnxMaskToSVG } from "../../lib/mask_utils";
import { modelData } from "../../lib/models";

const UPLOAD_IMAGE_SIZE = 1024;

function trim(pixels: ImageData) {
  const bound = {
    top: pixels.height,
    left: pixels.width,
    right: 0,
    bottom: 0,
  };

  for (let x = 0; x < pixels.width; x++) {
    for (let y = 0; y < pixels.height; y++) {
      const i = (y * pixels.width + x) * 4;
      if (pixels.data[i + 3] === 0) {
        continue;
      }
      if (y < bound.top) {
        bound.top = y;
      }
      if (x < bound.left) {
        bound.left = x;
      }
      if (x > bound.right) {
        bound.right = x;
      }
      if (y > bound.bottom) {
        bound.bottom = y;
      }
    }
  }

  const trimHeight = bound.bottom - bound.top + 1,
    trimWidth = bound.right - bound.left + 1;
  if (trimWidth <= 0 || trimHeight <= 0) {
    return null;
  }
  return [bound.left, bound.top, trimWidth, trimHeight];
}

export default function useImageEditor(image: Blob, sandbox: Window | null) {
  const [bitmap, setBitmap] = React.useState<HTMLImageElement | null>(null);
  const [embeddings, setEmbeddings] = React.useState<Tensor | null>(null);
  // the image mask, not necessarily same dimensions as image
  const [clicks, setClicks] = React.useState<{ x: number; y: number }[]>([]);
  // the masked image
  const [mask, setMask] = React.useState<Tensor | null>(null);
  const [renderedImage, setRenderedImage] = React.useState<Blob | null>(null);
  const predMasksRef = React.useRef<Tensor[]>([]);

  React.useEffect(() => {
    const img = new Image();
    img.src = URL.createObjectURL(image);
    img.onload = () => {
      setBitmap(img);
    };
  }, [image]);

  React.useEffect(() => {
    if (!bitmap) {
      return;
    }
    const scale = UPLOAD_IMAGE_SIZE / Math.max(bitmap.width, bitmap.height);
    const scaledWidth = Math.round(bitmap.width * scale);
    const scaledHeight = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(scaledWidth, scaledHeight),
      ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("Could not get context");
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    canvas.convertToBlob().then(async (resized) => {
      const buffer = await resized.arrayBuffer();
      const data = await new Promise<string>((resolve) => {
        const data = {
          action: "embeddings",
          embeddings: {
            data: Array.from(new Uint8Array(buffer)),
            type: resized.type,
          },
        };
        chrome.runtime.sendMessage(data, resolve);
      });
      const uint8arr = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      const float32Arr = new Float32Array(uint8arr.buffer);
      setEmbeddings(new Tensor("float32", float32Arr, [1, 256, 64, 64]));
    });

    const listener = (event: MessageEvent) => {
      setMask(event.data.output);
      predMasksRef.current.push(event.data.mask);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [bitmap]);

  React.useEffect(() => {
    if (!bitmap || !embeddings || !sandbox) {
      return;
    }
    const uploadScale =
      UPLOAD_IMAGE_SIZE / Math.max(bitmap.height, bitmap.width);
    const w = bitmap.width;
    const h = bitmap.height;
    const IMAGE_SIZE = 500;
    const d = Math.min(w, h);
    let scale = IMAGE_SIZE / d;
    if (d * scale > 1333) {
      scale = 1333 / d;
    }
    const modelScale = {
      onnxScale: scale / uploadScale,
      maskWidth: w * uploadScale,
      maskHeight: h * uploadScale,
      scale: scale,
      uploadScale: uploadScale,
      width: w,
      height: h,
    };
    if (clicks.length === 0) {
      setMask(null);
      setRenderedImage(null);
      predMasksRef.current.splice(0, predMasksRef.current.length);
      return;
    }
    const predMasks = predMasksRef.current;
    const feeds = modelData({
      clicks: clicks.map((click) => ({
        x: click.x,
        y: click.y,
        width: null,
        height: null,
        clickType: 1,
      })),
      tensor: embeddings,
      modelScale,
      last_pred_mask:
        predMasks.length > 0 ? predMasks[predMasks.length - 1] : null,
    });
    if (!feeds) {
      return;
    }
    sandbox.postMessage(feeds, "*");
  }, [embeddings, bitmap, clicks, sandbox]);

  const traced = React.useMemo(() => {
    if (!bitmap || !mask) {
      return null;
    }
    const scale = Math.max(bitmap.height, bitmap.width) / UPLOAD_IMAGE_SIZE;
    const paths = traceOnnxMaskToSVG(
      mask.data,
      mask.dims[1],
      mask.dims[0],
      scale
    );
    return paths;
  }, [bitmap, mask]);

  React.useEffect(() => {
    if (!bitmap || !traced) {
      return;
    }
    const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height);
    const offscreenCtx = offscreen.getContext("2d", {
      willReadFrequently: true,
    });
    if (!offscreenCtx) return;
    for (const path of traced) {
      offscreenCtx.fill(new Path2D(path));
    }
    offscreenCtx.fillStyle = "rgba(0, 0, 0, 1)";
    offscreenCtx.globalCompositeOperation = "source-in";
    offscreenCtx.drawImage(bitmap, 0, 0);
    const trimmed = trim(
      offscreenCtx.getImageData(0, 0, bitmap.width, bitmap.height)
    );
    if (trimmed == null) {
      setRenderedImage(null);
    } else {
      const [tx, ty, tw, th] = trimmed;
      const copy = new OffscreenCanvas(bitmap.width, bitmap.height);
      const copyCtx = copy.getContext("2d");
      if (copyCtx === null) {
        throw new Error("Could not get context");
      }
      copyCtx.fillStyle = "white";
      copyCtx.fillRect(0, 0, bitmap.width, bitmap.height);
      var imageData = offscreenCtx.getImageData(tx, ty, tw, th);
      for (let i = 0; i < imageData.data.length; i += 4) {
        if (imageData.data[i + 3] !== 0) {
          imageData.data[i] = 0;
          imageData.data[i + 1] = 0;
          imageData.data[i + 2] = 0;
        } else {
          imageData.data[i] = 255;
          imageData.data[i + 1] = 255;
          imageData.data[i + 2] = 255;
          imageData.data[i + 3] = 255;
        }
      }
      copyCtx.putImageData(imageData, tx, ty);
      copy.convertToBlob({ type: "image/png" }).then(setRenderedImage);
    }
  }, [bitmap, traced]);

  return {
    bitmap,
    mask,
    traced,
    renderedImage,
    isLoading: !bitmap || !embeddings,
    onClick(x: number, y: number, type: "left" | "right") {
      setClicks((clicks) => [...clicks, { x, y }]);
    },
    onUndo() {
      setClicks((clicks) => clicks.slice(0, -1));
      predMasksRef.current.pop();
    },
    isUndoable: clicks.length > 0,
  };
}
