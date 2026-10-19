// Supply a separately authenticated synthetic account context for isolation checks.
export async function checkCrossAccount({origin,assert,fileId,privateSrc,otherContext}) {
  if (!otherContext) return {skipped:true,reason:'No separate fixture account context supplied'};
  for (const url of [`/api/files/${fileId}/share`,`/api/files/${fileId}/preview`,`/api/files/${fileId}/web-session`,privateSrc]) {
    assert.equal((await otherContext.request.get(url.startsWith('/api/')?origin+url:new URL(url,origin).href)).status(),404);
  }
  return {skipped:false,checks:['different-account-metadata-content-runtime-share-denied']};
}
