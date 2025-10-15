import express from "express";
import multer from "multer";
import fetch from "node-fetch";

const app = express();

// Basic CORS for cross-origin frontends (Vercel, etc.)
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "2mb" }));

// Multer in-memory storage, limit file size to ~30MB
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 30 * 1024 * 1024
  }
});

 // Environment variables
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_MODEL_VERSION = process.env.REPLICATE_MODEL_VERSION;
// You must set both before running in production

// Parse model/version from combined env like "uglyrobot/sora2-watermark-remover:VERSION_HASH"
function parseReplicateModelVersion(val) {
  if (!val) return { model: null, version: null };
  const hasColon = val.includes(":");
  if (hasColon) {
    const [model, version] = val.split(":");
    return { model: model || null, version: version || null };
  }
  // if only version hash was provided
  return { model: null, version: val };
}
const { model: REPLICATE_MODEL_SLUG, version: REPLICATE_VERSION_ID } = parseReplicateModelVersion(REPLICATE_MODEL_VERSION);

if (!REPLICATE_API_TOKEN) {
  console.warn("Warning: REPLICATE_API_TOKEN is not set. Please set it before calling /api/remove.");
}
if (!REPLICATE_MODEL_VERSION) {
  console.warn("Warning: REPLICATE_MODEL_VERSION is not set. Please set it to the specific version ID from Replicate.");
} else {
  console.log("Replicate config -> model:", REPLICATE_MODEL_SLUG || "(none)","version:", REPLICATE_VERSION_ID || "(none)");
}

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "SoraWatermarkCleaner",
    replicateConfigured: !!(REPLICATE_API_TOKEN && REPLICATE_MODEL_VERSION)
  });
});

// Upload buffer to Replicate uploads to get a temporary URL (Node-friendly)
async function uploadToReplicate(fileBuffer, filename) {
  // Infer a basic content type from extension; fallback to mp4
  const lower = (filename || "").toLowerCase();
  const contentType =
    lower.endsWith(".mov") ? "video/quicktime" :
    lower.endsWith(".mp4") ? "video/mp4" :
    "video/mp4";

  // Try Replicate Files API (preferred)
  try {
    const initResp = await fetch("https://api.replicate.com/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: filename || "upload.mp4",
        content_type: contentType
      })
    });

    if (!initResp.ok) {
      const text = await initResp.text();
      throw new Error(`Replicate upload init failed: ${initResp.status} ${text}`);
    }

    const initData = await initResp.json();
    const uploadUrl = initData.upload_url;
    const serveUrl = initData.serve_url || initData.serving_url || initData.url;

    if (!uploadUrl || !serveUrl) {
      throw new Error(`Replicate upload init missing URLs: ${JSON.stringify(initData)}`);
    }

    const putResp = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileBuffer.length)
      },
      body: fileBuffer
    });

    if (!putResp.ok) {
      const text = await putResp.text().catch(() => "");
      throw new Error(`Replicate upload PUT failed: ${putResp.status} ${text}`);
    }

    return serveUrl;
  } catch (err) {
    console.error("Replicate files upload failed, falling back to transfer.sh:", err?.message || err);
    // Fallback: upload to transfer.sh to get a temporary public URL
    const safeName = (filename || "upload.mp4").replace(/\s+/g, "_");
    const tsUrl = `https://transfer.sh/${safeName}`;
    const tsResp = await fetch(tsUrl, {
      method: "PUT",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileBuffer.length)
      },
      body: fileBuffer
    });
    if (!tsResp.ok) {
      const text = await tsResp.text().catch(() => "");
      throw new Error(`Fallback upload failed: ${tsResp.status} ${text}`);
    }
    const publicUrl = (await tsResp.text()).trim();
    return publicUrl;
  }
}

// Start a prediction and poll until completed
async function runPredictionWithUrl(videoUrl) {
  // When using model-version endpoint, body should only include input
  // To maximize compatibility across versions, include multiple commonly used keys.
  const body = {
    input: {
      video: videoUrl,
      video_url: videoUrl,
      input_video: videoUrl
    }
  };

  // Prefer model-version endpoint to avoid ambiguity with generic /predictions
  const endpoint =
    REPLICATE_MODEL_SLUG && (REPLICATE_VERSION_ID || REPLICATE_MODEL_VERSION)
      ? `https://api.replicate.com/v1/models/${REPLICATE_MODEL_SLUG}/versions/${REPLICATE_VERSION_ID || REPLICATE_MODEL_VERSION}/predictions`
      : "https://api.replicate.com/v1/predictions";

  console.log("Starting Replicate prediction -> endpoint:", endpoint, "input keys:", Object.keys(body.input));

  const startResp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!startResp.ok) {
    const text = await startResp.text();
    throw new Error(`Replicate prediction start failed: ${startResp.status} ${text}`);
  }

  const startData = await startResp.json();
  const predictionId = startData.id;

  let status = startData.status;
  let lastData = startData;

  const startedAt = Date.now();
  const timeoutMs = 2 * 60 * 1000; // 2 minutes safety timeout

  while (["starting", "processing"].includes(status)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Prediction timed out.");
    }
    await new Promise((r) => setTimeout(r, 2000));

    const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`
      }
    });

    if (!pollResp.ok) {
      const text = await pollResp.text();
      throw new Error(`Replicate prediction poll failed: ${pollResp.status} ${text}`);
    }
    lastData = await pollResp.json();
    status = lastData.status;
  }

  if (status !== "succeeded") {
    throw new Error(`Prediction ended with status: ${status}, error: ${lastData.error || "unknown"}`);
  }

  return lastData; // contains output
}

// Main endpoint: supports either pasted URL or file upload
app.post("/api/remove", upload.single("file"), async (req, res) => {
  try {
    if (!REPLICATE_API_TOKEN || !REPLICATE_MODEL_VERSION) {
      return res.status(500).json({ error: "Server not configured. Set REPLICATE_API_TOKEN and REPLICATE_MODEL_VERSION." });
    }

    // If JSON body with url
    if (req.is("application/json") && req.body && req.body.url) {
      const videoUrl = String(req.body.url).trim();
      if (!videoUrl) return res.status(400).json({ error: "Invalid URL." });

      const prediction = await runPredictionWithUrl(videoUrl);
      return res.json({
        status: prediction.status,
        output: prediction.output,
        logs: prediction.logs || null
      });
    }

    // If multipart with file
    if (req.file) {
      const file = req.file;
      if (!file.buffer || !file.originalname) {
        return res.status(400).json({ error: "Invalid file upload." });
      }
      // Client side already limits to 30MB, we additionally rely on multer limit.
      const tempUrl = await uploadToReplicate(file.buffer, file.originalname);
      const prediction = await runPredictionWithUrl(tempUrl);
      return res.json({
        status: prediction.status,
        output: prediction.output,
        logs: prediction.logs || null
      });
    }

    return res.status(400).json({ error: "Provide either JSON {url} or multipart with 'file'." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

// Static site (optional if hosting backend-only on Render)
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sora Watermark Cleaner server running at http://localhost:${PORT}`);
});