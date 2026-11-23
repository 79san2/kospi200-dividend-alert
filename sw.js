self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate" || !event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>배당 알리미</title><main><h1>인터넷 연결을 확인하세요</h1><p>연결한 뒤 다시 열면 최신 배당 일정을 확인할 수 있습니다.</p><a href="./">다시 열기</a></main></html>',
    {status: 503, headers: {"Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store"}}
  )));
});
