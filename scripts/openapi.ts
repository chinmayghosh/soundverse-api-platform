// Writes docs/openapi.json from the same schemas the API validates with.
import { writeFileSync } from "node:fs";
import { buildOpenApiDocument } from "../src/server/openapi";

writeFileSync("docs/openapi.json", JSON.stringify(buildOpenApiDocument(), null, 2) + "\n");
console.log("wrote docs/openapi.json");
