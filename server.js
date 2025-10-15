import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";

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

if (!REPLICATE_API_TOKEN) {
  console.warn("Warning: REPLICATE_API_TOKEN is not set. Please set it before calling /api/remove.");
}
if (!REPLICATE_MODEL_VERSION) {
  console.warn("Warning: REPLICATE_MODEL_VERSION is not set. Please set it to the specific version ID from Replicate.");
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
  const formData = new FormData();
  formData.append("file", fileBuffer, {
    filename: filename || "upload.mov",
    contentType: "application/octet-stream"
  });

  const resp = await fetch("https://api.replicate.com/v1/uploads", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REPLICATE_API_TOKEN}`
    },
    body: formData
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Replicate upload failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  // data.url is a temporary public URL that can be used as model input
  return data.url;
}

// Start a prediction and poll until completed
async function runPredictionWithUrl(videoUrl) {
  const body = {
    version: REPLICATE_MODEL_VERSION,
    input: {
      // For uglyrobot/sora2-watermark-remover, input is "video_url"
      video_url: videoUrl
    }
  };

  const startResp = await fetch("https://api.replicate.com/v1/predictions", {
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