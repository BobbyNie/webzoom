// This opt-in download is a UX policy, not DRM: viewers can always take OS screenshots.
export async function exportAnnotatedFrame(canvas:HTMLCanvasElement,overlay:SVGSVGElement|null,includeAnnotations:boolean){
 if(!canvas.width||!canvas.height)throw new Error('尚无可保存的画面。');
 if(canvas.width*canvas.height>16777216)throw new Error('画面过大，请降低共享分辨率后再保存。');
 const output=document.createElement('canvas');output.width=canvas.width;output.height=canvas.height;
 const ctx=output.getContext('2d');if(!ctx)throw new Error('浏览器无法生成截图。');ctx.drawImage(canvas,0,0);
 if(overlay&&includeAnnotations){
  const copy=overlay.cloneNode(true) as SVGSVGElement;copy.setAttribute('xmlns','http://www.w3.org/2000/svg');copy.setAttribute('width',String(canvas.width));copy.setAttribute('height',String(canvas.height));
  copy.removeAttribute('style');copy.removeAttribute('class');copy.querySelector('[data-testid="annotation-pending"]')?.remove();
  // data: is already allowed by the strict image CSP; do not broaden it for blob: images.
  const image=new Image();image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(new XMLSerializer().serializeToString(copy));
  try{await image.decode()}catch{throw new Error('浏览器无法合成批注截图，请重试或先隐藏批注。')}
  ctx.drawImage(image,0,0,canvas.width,canvas.height)
 }
 const blob=await new Promise<Blob>((resolve,reject)=>output.toBlob(b=>b?resolve(b):reject(new Error('截图生成失败。')),'image/png'));
 const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`webzoom-${new Date().toISOString().replace(/[:.]/g,'-')}.png`;
 document.body.append(link);link.click();link.remove();window.setTimeout(()=>URL.revokeObjectURL(url),10000);
}
