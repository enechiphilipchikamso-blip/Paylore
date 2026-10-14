import { spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  Reporter,
  TestCase,
  TestResult
} from "@playwright/test/reporter";

export default class MergeVideoReporter implements Reporter {
  private readonly outputDir = join(process.cwd(), "test-results");
  private readonly testIds = new Set<string>();
  private readonly videosByTestId = new Map<string, string>();

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== "skipped") {
      this.testIds.add(test.id);
    }

    for (const attachment of result.attachments) {
      if (attachment.contentType === "video/webm" && attachment.path) {
        this.videosByTestId.set(test.id, attachment.path);
      }
    }
  }

  async onEnd() {
    if (this.testIds.size === 0) {
      return;
    }

    const missingVideos = [...this.testIds].filter(
      (testId) => !this.videosByTestId.has(testId)
    );
    if (missingVideos.length > 0) {
      console.warn(
        `Could not create videos for ${missingVideos.length} of ${this.testIds.size} executed tests; combining the available videos.`
      );
    }

    const videoPaths = [...this.videosByTestId.values()];
    if (videoPaths.length === 0) {
      throw new Error("Playwright finished without producing any test videos.");
    }

    await mkdir(this.outputDir, { recursive: true });

    const outputPath = join(this.outputDir, "verification.mp4");
    const videoInputs = videoPaths.flatMap((videoPath) => ["-i", videoPath]);
    const videoFilters = videoPaths
      .map(
        (_, index) =>
          `[${index}:v]setpts=PTS-STARTPTS,fps=30,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v${index}]`
      )
      .join(";");
    const concatInputs = videoPaths.map((_, index) => `[v${index}]`).join("");
    const filterGraph = `${videoFilters};${concatInputs}concat=n=${videoPaths.length}:v=1:a=0[outv]`;

    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        ...videoInputs,
        "-filter_complex",
        filterGraph,
        "-map",
        "[outv]",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        outputPath
      ],
      { encoding: "utf8" }
    );

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || `ffmpeg exited with ${result.status}`);
    }

    console.log(
      `Combined ${videoPaths.length} Playwright videos from ${this.videosByTestId.size} tests into ${outputPath}`
    );
  }
}
