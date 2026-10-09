import { buildOpenApiDocument } from "@/server/openapi";

// Public, unauthenticated: the spec is documentation.
export function GET() {
  return Response.json(buildOpenApiDocument());
}
