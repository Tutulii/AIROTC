import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const copies = [
  {
    from: path.resolve(
      projectRoot,
      "../../middleman-agent/src/encrypt-sdk/proto/encrypt_service.proto"
    ),
    to: path.resolve(projectRoot, "dist/proto/encrypt_service.proto"),
  },
];

for (const copy of copies) {
  if (!fs.existsSync(copy.from)) {
    throw new Error(`Missing SDK build asset: ${copy.from}`);
  }
  fs.mkdirSync(path.dirname(copy.to), { recursive: true });
  fs.copyFileSync(copy.from, copy.to);
}

console.log("[sdk-build] copied runtime assets");
