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
  // 推断 content-type，默认 mp4
  const lower = (filename || "").toLowerCase();
  const contentType =
    lower.endsWith(".mov") ? "video/quicktime" :
    lower.endsWith(".mp4") ? "video/mp4" :
    "video/mp4";

  // 1) 稳定托管：catbox.moe
  try {
    const fdCat = new FormData();
    fdCat.append("reqtype", "fileupload");
    fdCat.append("fileToUpload", fileBuffer, {
      filename: filename || "upload.mp4",
      contentType
    });
    const headersCat = fdCat.getHeaders();
    const respCat = await fetch("https://catbox.moe/user/api.php", {
      method: "POST",
      headers: headersCat,
      body: fdCat
    });
    if (!respCat.ok) {
      const text = await respCat.text().catch(() => "");
      throw new Error(`catbox upload failed: ${respCat.status} ${text}`);
    }
    const catUrl = (await respCat.text()).trim().replace(/^http:\/\//, "https://");
    if (catUrl && /^https:\/\/files\.catbox\.moe\//.test(catUrl)) {
      console.log("catbox upload ok ->", catUrl);
      return catUrl;
    }
    console.warn("catbox upload returned unexpected url:", catUrl);
  } catch (e) {
    console.error("catbox upload error:", e?.message || e);
  }

  // 2) 次选：tmpfiles.org（规范成直链）
  try {
    const fd2 = new FormData();
    fd2.append("file", fileBuffer, {
      filename: filename || "upload.mp4",
      contentType
    });
    const r2 = await fetch("https://tmpfiles.org/api/v1/upload", {
      method: "POST",
      headers: fd2.getHeaders(),
      body: fd2
    });
    if (!r2.ok) {
      const text = await r2.text().catch(() => "");
      throw new Error(`tmpfiles upload failed: ${r2.status} ${text}`);
    }
    const j = await r2.json().catch(() => ({}));
    let url = j?.data?.url || j?.url;
    if (url) {
      url = url.replace(/^http:\/\//, "https://");
      const m = url.match(/^https:\/\/tmpfiles\.org\/([^\/\?\#]+)/);
      if (m) url = `https://tmpfiles.org/dl/${m[1]}`;
      console.log("tmpfiles upload ok ->", url);
      return url;
    }
    console.warn("tmpfiles upload returned no url, falling back...");
  } catch (e) {
    console.error("tmpfiles upload error:", e?.message || e);
  }

  // 3) 最后回退：transfer.sh
  try {
    const rawName = (filename || "upload.mp4").toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9._-]/g, "-");
    const safeName = encodeURIComponent(rawName);
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
      throw new Error(`transfer.sh upload failed: ${tsResp.status} ${text}`);
    }
    const publicUrl = (await tsResp.text()).trim().replace(/^http:\/\//, "https://");
    console.log("transfer.sh upload ok ->", publicUrl);
    return publicUrl;
  } catch (e) {
    console.error("transfer.sh upload error:", e?.message || e);
  }

  throw new Error("All upload strategies failed (catbox.moe, tmpfiles.org, transfer.sh).");
}

// Start a prediction and poll until completed
async function runPredictionWithUrl(videoUrl) {
  // 简化为该模型文档示例：仅传 input.video
  const body = {
    input: {
      video: videoUrl
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
  const timeoutMs = 10 * 60 * 1000; // 10 minutes safety timeout

  while (["queued", "starting", "processing"].includes(status)) {
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