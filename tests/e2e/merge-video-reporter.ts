import { spawnSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  Reporter,
  TestCase,
  TestResult
} from "@playwright/test/reporter";

export default class MergeVideoReporter implements Reporter {
  private readonly outputDir = join(process.cwd(), "test-results");
  private readonly videoPaths: string[] = [];
  private readonly testIds = new Set<string>();
  private readonly videoTestIds = new Set<string>();

  onTestEnd(test: TestCase, result: TestResult) {
    if (result.status !== "skipped") {
      this.testIds.add(test.id);
    }

    for (const attachment of result.attachments) {
      if (attachment.contentType === "video/webm" && attachment.path) {
        this.videoPaths.push(attachment.path);
        this.videoTestIds.add(test.id);
      }
    }
  }

  async onEnd() {
    if (this.testIds.size === 0) {
      return;
    }

    if (this.videoTestIds.size !== this.testIds.size) {
      const missingVideos = [...this.testIds].filter(
        (testId) => !this.videoTestIds.has(testId)
      );
      throw new Error(
        `Could not create a video for ${missingVideos.length} of ${this.testIds.size} executed tests.`
      );
    }

    if (this.videoPaths.length === 0) {
      throw new Error("Playwright finished without producing any test videos.");
    }

    await mkdir(this.outputDir, { recursive: true });

    const listPath = join(this.outputDir, ".verification-video-inputs.txt");
    const outputPath = join(this.outputDir, "verification.mp4");
    const concatList = this.videoPaths
      .map((videoPath) => `file '${videoPath.replaceAll("'", "'\\''")}'`)
      .join("\n");

    await writeFile(listPath, `${concatList}\n`);

    try {
      const result = spawnSync(
        "ffmpeg",
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listPath,
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
        `Combined ${this.videoPaths.length} Playwright videos from ${this.videoTestIds.size} tests into ${outputPath}`
      );
    } finally {
      await unlink(listPath);
    }
  }
}
