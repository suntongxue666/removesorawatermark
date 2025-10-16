import express from "express";
import multer from "multer";
import fetch from "node-fetch";
import FormData from "form-data";
import fs from "fs";
import path from "path";

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
// Optional stable video hosting: Cloudinary unsigned upload
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || "";
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || "";
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

  // 0) 优先：Cloudinary unsigned upload（稳定直链 https）
  try {
    if (CLOUDINARY_CLOUD_NAME && CLOUDINARY_UPLOAD_PRESET) {
      const fd = new FormData();
      fd.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
      fd.append("file", fileBuffer, {
        filename: filename || "upload.mp4",
        contentType
      });
      const headers = fd.getHeaders();
      const resp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/video/upload`, {
        method: "POST",
        headers,
        body: fd
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`cloudinary upload failed: ${resp.status} ${text}`);
      }
      const j = await resp.json().catch(() => ({}));
      const url = (j.secure_url || j.url || "").replace(/^http:\/\//, "https://");
      if (url) {
        console.log("cloudinary upload ok ->", url);
        return url;
      }
      console.warn("cloudinary upload returned no url", j);
    }
  } catch (e) {
    console.error("cloudinary upload error:", e?.message || e);
  }

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
async function runPredictionWithUrl(videoUrl, onLog = () => {}) {
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

  onLog(`start: POST ${endpoint}`);
  onLog(`input: keys=${Object.keys(body.input).join(",")} video=${videoUrl}`);
  console.log("Starting Replicate prediction -> endpoint:", endpoint, "input keys:", Object.keys(body.input));

  const startResp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  onLog(`start: response ${startResp.status}`);

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
      onLog("error: timed out");
      throw new Error("Prediction timed out.");
    }
    await new Promise((r) => setTimeout(r, 2000));
    onLog(`poll: GET /v1/predictions/${predictionId}`);

    const pollResp = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`
      }
    });

    if (!pollResp.ok) {
      const text = await pollResp.text();
      onLog(`poll: response ${pollResp.status} ${String(text).slice(0,200)}`);
      throw new Error(`Replicate prediction poll failed: ${pollResp.status} ${text}`);
    }
    lastData = await pollResp.json();
    status = lastData.status;
    onLog(`status: ${status}`);
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

      const logs = [];
      const prediction = await runPredictionWithUrl(videoUrl, (m) => logs.push(m));
      return res.json({
        status: prediction.status,
        output: prediction.output,
        logs: [...logs, ...(prediction.logs ? [String(prediction.logs)] : [])].join("\n")
      });
    }

    // If multipart with file
    if (req.file) {
      const file = req.file;
      if (!file.buffer || !file.originalname) {
        return res.status(400).json({ error: "Invalid file upload." });
      }
      const logs = [];
      // Client side already limits to 30MB, we additionally rely on multer limit.
      const tempUrl = await uploadToReplicate(file.buffer, file.originalname);
      logs.push(`upload: ok -> ${tempUrl}`);
      const prediction = await runPredictionWithUrl(tempUrl, (m) => logs.push(m));
      return res.json({
        status: prediction.status,
        output: prediction.output,
        logs: [...logs, ...(prediction.logs ? [String(prediction.logs)] : [])].join("\n")
      });
    }

    return res.status(400).json({ error: "Provide either JSON {url} or multipart with 'file'." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const url = String(req.query.url || "").trim();
    const filename = String(req.query.filename || "cleaned.mp4").replace(/[^a-zA-Z0-9._-]/g, "_");
    if (!url) return res.status(400).send("Missing url");

    const upstream = await fetch(url);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return res.status(502).send(`Upstream error ${upstream.status} ${text.slice(0, 200)}`);
    }

    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    if (upstream.body && upstream.body.pipe) {
      upstream.body.pipe(res);
    } else if (upstream.arrayBuffer) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } else {
      const buf = await upstream.buffer();
      res.send(buf);
    }
  } catch (e) {
    res.status(500).send(e?.message || "download proxy error");
  }
});

app.get("/sitemap.htm", (req, res) => {
  try {
    const pubDir = path.join(process.cwd(), "public");
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    function walk(dir) {
      const out = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          out.push(...walk(full));
        } else if (e.isFile() && e.name.toLowerCase().endsWith(".html")) {
          const rel = path.relative(pubDir, full).replace(/\\/g, "/");
          // 将 index.html 映射为根路径
          const urlPath = rel === "index.html" ? "/" : `/${rel}`;
          out.push({ rel, url: baseUrl + urlPath });
        }
      }
      return out;
    }

    const pages = walk(pubDir)
      // 排序：index 首页优先，其余按字母序
      .sort((a, b) => {
        if (a.rel === "index.html") return -1;
        if (b.rel === "index.html") return 1;
        return a.rel.localeCompare(b.rel);
      });

    // 生成简洁 HTML 站点地图
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>HTML Sitemap - Remove Sora Watermark</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow">
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.6;margin:24px;color:#111}
    h1{font-size:22px;margin:0 0 12px}
    ul{margin:12px 0;padding-left:18px}
    li{margin:6px 0}
    small{color:#666}
    .path{color:#555;font-size:12px;margin-left:8px}
  </style>
  <link rel="canonical" href="${baseUrl}/sitemap.htm">
</head>
<body>
  <h1>HTML Sitemap</h1>
  <p><small>Auto-generated at ${new Date().toISOString()}</small></p>
  <ul>
    ${pages.map(p => `<li><a href="${p.url}">${p.url}</a><span class="path">(${p.rel})</span></li>`).join("\n    ")}
  </ul>
</body>
</html>`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(html);
  } catch (e) {
    return res.status(500).send("Failed to build sitemap: " + (e?.message || e));
  }
});

// Static site (optional if hosting backend-only on Render)
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sora Watermark Cleaner server running at http://localhost:${PORT}`);
});