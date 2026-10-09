import express from "express";
import cors from "cors";
import multer from "multer";
import Replicate from "replicate";
import ffmpegPath from "ffmpeg-static";

import fs from "node:fs/promises";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const app = express();

app.use(cors());

app.use(
  express.json({
    limit: "10mb"
  })
);

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

const WHISPER_MODEL =
  "openai/whisper:8099696689d249cf8b122d833c36ac3f75505c666a395ca40ef26f68e7d3d16e";


/*
|--------------------------------------------------------------------------
| Helpers
|--------------------------------------------------------------------------
*/

async function deleteFile(path) {
  if (!path) return;

  try {
    await fs.unlink(path);
  } catch (_) {}
}


function assTime(seconds) {
  const value = Math.max(
    0,
    Number(seconds) || 0
  );

  const totalCentiseconds =
    Math.round(value * 100);

  const hours =
    Math.floor(
      totalCentiseconds / 360000
    );

  const minutes =
    Math.floor(
      (totalCentiseconds % 360000) /
        6000
    );

  const secs =
    Math.floor(
      (totalCentiseconds % 6000) /
        100
    );

  const centiseconds =
    totalCentiseconds % 100;

  return (
    `${hours}:` +
    `${minutes.toString().padStart(2, "0")}:` +
    `${secs.toString().padStart(2, "0")}.` +
    `${centiseconds
      .toString()
      .padStart(2, "0")}`
  );
}
function extractYouTubeVideoId(url) {
  try {
    const parsed = new URL(url);

    if (parsed.hostname === "youtu.be") {
      return parsed.pathname
        .replace("/", "")
        .split("?")[0];
    }

    if (
      parsed.hostname === "youtube.com" ||
      parsed.hostname === "www.youtube.com" ||
      parsed.hostname === "m.youtube.com"
    ) {
      return parsed.searchParams.get("v");
    }

    return null;
  } catch (_) {
    return null;
  }
}
function wrapLyricsText(text) {
  const cleanText = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleanText) {
    return "";
  }

  const words = cleanText.split(" ");

  const lines = [];
  let currentLine = "";

  const maxCharsPerLine = 32;

  for (const word of words) {
    const testLine =
      currentLine.length === 0
        ? word
        : `${currentLine} ${word}`;

    if (
      testLine.length >
      maxCharsPerLine &&
      currentLine.length > 0
    ) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines
    .slice(0, 3)
    .map((line) =>
      line
        .replaceAll("\\", "\\\\")
        .replaceAll("{", "\\{")
        .replaceAll("}", "\\}")
    )
    .join("\\N");
}
function escapeAssText(text) {
  return String(text ?? "")
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replace(/\r?\n/g, "\\N")
    .trim();
}
app.post("/api/youtube/info", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "YouTube URL is required."
      });
    }

    const videoId =
      extractYouTubeVideoId(url);

    if (!videoId) {
      return res.status(400).json({
        success: false,
        message:
          "Please enter a valid YouTube video URL."
      });
    }

    const apiKey =
      process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        success: false,
        message:
          "YouTube API key is not configured."
      });
    }

    const response = await fetch(
      `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${apiKey}`
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "YouTube API error:",
        data
      );

      return res
        .status(response.status)
        .json({
          success: false,
          message:
            "Unable to contact YouTube API."
        });
    }

    if (
      !data.items ||
      data.items.length === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "YouTube video not found."
      });
    }

    const video = data.items[0];

    return res.json({
      success: true,
      videoId: video.id,
      title: video.snippet.title,
      channel:
        video.snippet.channelTitle,
      thumbnail:
        video.snippet.thumbnails
            ?.high?.url ??
        video.snippet.thumbnails
            ?.medium?.url ??
        video.snippet.thumbnails
            ?.default?.url ??
        ""
    });
  } catch (error) {
    console.error(
      "YouTube info error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load YouTube video.",
      error:
        error?.message ??
        "Unknown error"
    });
  }
});

function createAssContent(segments) {
  const header = `
[Script Info]
Title: Sarvesh Karaoke
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,44,&H00FFFFFF,&H0000FFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,100,100,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`.trim();

  const events = segments
    .filter(
      (segment) =>
        segment &&
        segment.text &&
        Number(segment.end) >
          Number(segment.start)
    )
    .map((segment) => {
      const start =
        assTime(segment.start);

      const end =
        assTime(segment.end);

      const text =
        wrapLyricsText(
          segment.text
        );

      return (
        `Dialogue: 0,${start},${end},` +
        `Default,,0,0,0,,${text}`
      );
    });

  return `${header}\n${events.join("\n")}\n`;
}


function buildAtempoFilters(
  tempoFactor
) {
  let value = tempoFactor;

  const filters = [];

  while (value < 0.5) {
    filters.push(
      "atempo=0.5"
    );

    value /= 0.5;
  }

  while (value > 2.0) {
    filters.push(
      "atempo=2.0"
    );

    value /= 2.0;
  }

  filters.push(
    `atempo=${value.toFixed(8)}`
  );

  return filters.join(",");
}


function runFfmpeg(args) {
  return new Promise(
    (resolve, reject) => {
      if (!ffmpegPath) {
        reject(
          new Error(
            "FFmpeg binary is unavailable."
          )
        );

        return;
      }

      const process = spawn(
        ffmpegPath,
        args,
        {
          stdio: [
            "ignore",
            "ignore",
            "pipe"
          ]
        }
      );

      let errorOutput = "";

      process.stderr.on(
        "data",
        (data) => {
          errorOutput +=
            data.toString();

          if (
            errorOutput.length >
            12000
          ) {
            errorOutput =
              errorOutput.slice(
                -12000
              );
          }
        }
      );

      process.on(
        "error",
        reject
      );

      process.on(
        "close",
        (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `FFmpeg failed:\n${
                  errorOutput.slice(
                    -5000
                  )
                }`
              )
            );
          }
        }
      );
    }
  );
}


/*
|--------------------------------------------------------------------------
| Health
|--------------------------------------------------------------------------
*/

app.get("/", (req, res) => {
  res.json({
    success: true,
    message:
      "Sarvesh Karaoke API is running"
  });
});


/*
|--------------------------------------------------------------------------
| Create Karaoke
|--------------------------------------------------------------------------
*/
async function resolveYouTubeMedia(
  youtubeUrl
) {
  const resolverUrl =
    process.env
      .YOUTUBE_RESOLVER_URL;

  const resolverApiKey =
    process.env
      .YOUTUBE_RESOLVER_API_KEY;

  if (!resolverUrl) {
    throw new Error(
      "YouTube media resolver is not configured."
    );
  }

  const response =
    await fetch(
      resolverUrl,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          ...(resolverApiKey
            ? {
                Authorization:
                  `Bearer ${resolverApiKey}`
              }
            : {})
        },

        body:
          JSON.stringify({
            url:
              youtubeUrl
          })
      }
    );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message ??
        "Unable to resolve YouTube media."
    );
  }

  const mediaUrl =
    data?.mediaUrl ??
    data?.audioUrl ??
    data?.url;

  if (!mediaUrl) {
    throw new Error(
      "Resolver did not return a media URL."
    );
  }

  return mediaUrl;
}
app.post(
  "/api/karaoke/youtube",
  async (req, res) => {
    try {
      const {
        url
      } = req.body;

      if (
        !url ||
        typeof url !== "string"
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "YouTube URL is required."
          });
      }

      const videoId =
        extractYouTubeVideoId(
          url
        );

      if (!videoId) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Invalid YouTube URL."
          });
      }

      console.log(
        `Resolving YouTube media: ${videoId}`
      );

      const mediaUrl =
        await resolveYouTubeMedia(
          url
        );

      console.log(
        "Downloading resolved media..."
      );

      const mediaResponse =
        await fetch(
          mediaUrl
        );

      if (
        !mediaResponse.ok
      ) {
        throw new Error(
          "Unable to download resolved media."
        );
      }

      const arrayBuffer =
        await mediaResponse
          .arrayBuffer();

      const audioBuffer =
        Buffer.from(
          arrayBuffer
        );

      console.log(
        "Creating karaoke from YouTube media..."
      );

      const output =
        await replicate.run(
          DEMUCS_MODEL,
          {
            input: {
  audio: audioBuffer,
  stem: "vocals",
  model_name: "htdemucs_ft",
  shifts: 2,
  overlap: 0.25,
  clip_mode: "rescale",
  mp3_bitrate: 256,
  float32: false,
  output_format: "mp3"
}
          }
        );

      if (
        !output?.other
      ) {
        throw new Error(
          "Instrumental track was not returned."
        );
      }

      return res.json({
        success: true,

        originalFileName:
          `${videoId}.wav`,

        karaokeUrl:
          output.other,

        vocalsUrl:
          output.vocals ?? ""
      });
    } catch (error) {
      console.error(
        "YouTube karaoke error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,

          message:
            "Unable to create karaoke from YouTube.",

          error:
            error?.message ??
            "Unknown error"
        });
    }
  }
);
app.post(
  "/api/karaoke/create",
  upload.single("file"),
  async (req, res) => {
    let uploadedPath = null;

    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "No audio file uploaded."
          });
      }

      uploadedPath =
        req.file.path;

      console.log(
        `Creating karaoke for: ${
          req.file.originalname
        }`
      );

      const audioBuffer =
        await fs.readFile(
          uploadedPath
        );

      const output =
        await replicate.run(
          DEMUCS_MODEL,
          {
           input: {
  audio: audioBuffer,
  stem: "vocals",
  model_name: "htdemucs_ft",
  shifts: 2,
  overlap: 0.25,
  clip_mode: "rescale",
  mp3_bitrate: 256,
  float32: false,
  output_format: "mp3"
}
          }
        );

      if (!output?.other) {
        throw new Error(
          "Instrumental track was not returned."
        );
      }

      return res.json({
        success: true,

        originalFileName:
          req.file
            .originalname,

        karaokeUrl:
          output.other,

        vocalsUrl:
          output.vocals ?? ""
      });
    } catch (error) {
      console.error(
        "Karaoke error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to create karaoke.",
          error:
            error?.message ??
            "Unknown error"
        });
    } finally {
      await deleteFile(
        uploadedPath
      );
    }
  }
);


/*
|--------------------------------------------------------------------------
| Generate Lyrics
|--------------------------------------------------------------------------
*/

app.post(
  "/api/lyrics/generate",
  async (req, res) => {
    try {
      const {
        vocalsUrl
      } = req.body;

      if (
        !vocalsUrl ||
        typeof vocalsUrl !==
          "string"
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "vocalsUrl is required."
          });
      }

      console.log(
        "Generating lyrics..."
      );

      const output =
        await replicate.run(
          WHISPER_MODEL,
          {
            input: {
              audio:
                vocalsUrl,

              language:
                "auto",

              translate:
                false,

              temperature:
                0,

              transcription:
                "plain text",

              condition_on_previous_text:
                true,

              suppress_tokens:
                "-1",

              logprob_threshold:
                -1,

              no_speech_threshold:
                0.6,

              compression_ratio_threshold:
                2.4,

              temperature_increment_on_fallback:
                0.2
            }
          }
        );

      const segments =
        Array.isArray(
          output?.segments
        )
          ? output.segments
              .filter(
                (segment) =>
                  segment
                    .text &&
                  segment
                    .text
                    .trim()
                    .length >
                    0
              )
              .map(
                (segment) => ({
                  start:
                    Number(
                      segment.start
                    ) || 0,

                  end:
                    Number(
                      segment.end
                    ) || 0,

                  text:
                    segment
                      .text
                      .trim()
                })
              )
          : [];

      return res.json({
        success: true,

        language:
          output
            ?.detected_language ??
          "",

        transcription:
          output
            ?.transcription ??
          "",

        segments
      });
    } catch (error) {
      console.error(
        "Lyrics error:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          message:
            "Unable to generate lyrics.",
          error:
            error?.message ??
            "Unknown error"
        });
    }
  }
);


/*
|--------------------------------------------------------------------------
| Create Final Karaoke Video
|--------------------------------------------------------------------------
|
| multipart/form-data:
|
| file       = generated instrumental
| semitones  = selected pitch
| segments   = JSON lyrics array
|
*/

app.post(
  "/api/video/create",
  upload.single("file"),
  async (req, res) => {
    let inputPath = null;
    let assPath = null;
    let outputPath = null;

    try {
      if (!req.file) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Karaoke audio file is required."
          });
      }

      inputPath =
        req.file.path;

      const semitones =
        Number(
          req.body.semitones ?? 0
        );

      if (
        !Number.isFinite(
          semitones
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Invalid pitch value."
          });
      }

      let segments;

      try {
        segments =
          JSON.parse(
            req.body
              .segments ??
              "[]"
          );
      } catch (_) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Invalid lyrics data."
          });
      }

      if (
        !Array.isArray(
          segments
        ) ||
        segments.length === 0
      ) {
        return res
          .status(400)
          .json({
            success: false,
            message:
              "Lyrics segments are required."
          });
      }

      const id =
        crypto.randomUUID();

      assPath =
        `/tmp/${id}.ass`;

      outputPath =
        `/tmp/${id}.mp4`;

      const assContent =
        createAssContent(
          segments
        );

      await fs.writeFile(
        assPath,
        assContent,
        "utf8"
      );

      /*
       * Pitch shift while keeping
       * approximately the same duration.
       */

      const rateFactor =
        Math.pow(
          2,
          semitones / 12
        );

      const tempoFactor =
        1 / rateFactor;

      let audioFilters;

      if (
        Math.abs(
          semitones
        ) < 0.001
      ) {
        audioFilters =
          "aresample=44100";
      } else {
        audioFilters =
          `asetrate=44100*${rateFactor.toFixed(
            8
          )},` +
          "aresample=44100," +
          buildAtempoFilters(
            tempoFactor
          );
      }

      const filterComplex =
        `[0:v]ass=${assPath}[video];` +
        `[1:a]${audioFilters}[audio]`;

      console.log(
        `Rendering final video. Pitch: ${semitones}`
      );

      await runFfmpeg([
        "-y",

        "-f",
        "lavfi",

        "-i",
        "color=c=black:s=1280x720:r=24",

        "-i",
        inputPath,

        "-filter_complex",
        filterComplex,

        "-map",
        "[video]",

        "-map",
        "[audio]",

        "-c:v",
        "libx264",

        "-preset",
        "ultrafast",

        "-crf",
        "26",

        "-pix_fmt",
        "yuv420p",

        "-c:a",
        "aac",

        "-b:a",
        "320k",

        "-movflags",
        "+faststart",

        "-shortest",

        outputPath
      ]);

      console.log(
        "Video rendering completed."
      );

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="karaoke.mp4"'
      );

      return res.sendFile(
        outputPath,
        async (error) => {
          if (error) {
            console.error(
              "Video send error:",
              error
            );
          }

          await deleteFile(
            inputPath
          );

          await deleteFile(
            assPath
          );

          await deleteFile(
            outputPath
          );
        }
      );
    } catch (error) {
      console.error(
        "Video creation error:",
        error
      );

      await deleteFile(
        inputPath
      );

      await deleteFile(
        assPath
      );

      await deleteFile(
        outputPath
      );

      if (
        !res.headersSent
      ) {
        return res
          .status(500)
          .json({
            success: false,
            message:
              "Unable to create karaoke video.",
            error:
              error?.message ??
              "Unknown error"
          });
      }
    }
  }
);


/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((req, res) => {
  res
    .status(404)
    .json({
      success: false,
      message:
        "Endpoint not found."
    });
});

const port =
  process.env.PORT || 10000;

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `Server running on port ${port}`
    );
  }
);
