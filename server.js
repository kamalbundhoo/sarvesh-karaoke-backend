import express from "express";
import cors from "cors";
import multer from "multer";
import Replicate from "replicate";
import fs from "node:fs/promises";

const app = express();

app.use(cors());
app.use(express.json());

const upload = multer({
  dest: "/tmp/",
  limits: {
    fileSize: 100 * 1024 * 1024
  }
});

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
  useFileOutput: false
});

const DEMUCS_MODEL =
  "cjwbw/demucs:25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953";

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Sarvesh Karaoke API is running"
  });
});

app.post(
  "/api/karaoke/create",
  upload.single("file"),
  async (req, res) => {
    let uploadedPath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          message: "No audio file uploaded."
        });
      }

      uploadedPath = req.file.path;

      const audioBuffer =
        await fs.readFile(uploadedPath);

      const output = await replicate.run(
        DEMUCS_MODEL,
        {
          input: {
            audio: audioBuffer,
            stem: "vocals",
            model_name: "htdemucs",
            shifts: 1,
            overlap: 0.25,
            clip_mode: "rescale",
            mp3_bitrate: 320,
            float32: false,
            output_format: "mp3"
          }
        }
      );

      return res.json({
        success: true,
        originalFileName:
          req.file.originalname,
        karaokeUrl: output.other,
        vocalsUrl: output.vocals
      });
    } catch (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message: "Unable to create karaoke.",
        error: error.message
      });
    } finally {
      if (uploadedPath) {
        try {
          await fs.unlink(uploadedPath);
        } catch (_) {}
      }
    }
  }
);

const port = process.env.PORT || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
