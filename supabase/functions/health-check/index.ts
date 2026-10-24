// Public operational probe. No credentials, customer data or database access.
Deno.serve((request: Request) => {
  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: { "content-type": "application/json", "cache-control": "no-store", "allow": "GET" },
    });
  }
  return new Response(JSON.stringify({ service: "zurvan-license-server", status: "ok", api_version: "v2" }), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
});
