import { writeFileSync } from "node:fs";
import { openApiDocument } from "../src/app.ts";

const path = new URL("../openapi.json", import.meta.url);
writeFileSync(path, `${JSON.stringify(await openApiDocument(), null, 2)}\n`);
