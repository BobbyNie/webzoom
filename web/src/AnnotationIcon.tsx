import type {ReactNode} from 'react';

// Project-drawn vectors, not font glyphs: each tool keeps a distinct silhouette at 20px.
export const annotationIconNames = ['view','pen','pointer','highlighter','temporary','line','arrow','rectangle','ellipse','text','eraser','chevron-up','chevron-down','undo','eye','eye-off','more','close'] as const;
export type AnnotationIconName = typeof annotationIconNames[number];
const artwork: Record<AnnotationIconName, ReactNode> = {
 view: <path d="M4 3v17l4.7-4.4 3.4 6.4 3-1.6-3.4-6.3H19L4 3Z" fill="currentColor" stroke="none"/>,
 pen: <><path d="m4 20 1-5L16.2 3.8a2.1 2.1 0 0 1 3 3L8 18l-4 2Z"/><path d="m14.5 5.5 4 4M5 15l3 3M4 20h6"/></>,
 pointer: <><circle cx="12" cy="12" r="6.5"/><path d="M12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/></>,
 highlighter: <><path d="m5 13 8-9 6 5-8 9-6-5ZM5 13l-2 5 4 3 4-3M11 6l6 5M3 22h18"/><path d="m4 18 3 2" strokeWidth="3"/></>,
 temporary: <><path d="m3 15 1-4 9-9 3 3-9 9-4 1ZM11 4l3 3"/><circle cx="16" cy="16" r="6"/><path d="M16 12.5V16l2 1.5"/></>,
 line: <><path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="5" r="1.5" fill="currentColor" stroke="none"/></>,
 arrow: <path d="M4 20 20 4M10 4h10v10" strokeWidth="2.2"/>,
 rectangle: <rect x="3.5" y="5" width="17" height="14" rx="1.5"/>,
 ellipse: <ellipse cx="12" cy="12" rx="9" ry="7"/>,
 text: <path d="M5 7V4h14v3M12 4v16M8 20h8"/>,
 eraser: <><path d="m3.7 13.2 8.8-9a2 2 0 0 1 2.8 0l4.5 4.5a2 2 0 0 1 0 2.8L11.5 20h-5l-2.8-4a2 2 0 0 1 0-2.8Z"/><path d="m8 9 8 8M11 20h10"/></>,
 'chevron-up': <path d="m6 14 6-6 6 6"/>,
 'chevron-down': <path d="m6 10 6 6 6-6"/>,
 undo: <><path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12" transform="translate(0 -2)"/></>,
 eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
 'eye-off': <><path d="M3 3 21 21M10 5.2c.6-.1 1.3-.2 2-.2 6.5 0 10 7 10 7a18 18 0 0 1-3.2 4.2M6.2 6.2A19 19 0 0 0 2 12s3.5 7 10 7a11 11 0 0 0 4.2-.8M9.9 9.9a3 3 0 0 0 4.2 4.2"/></>,
 more: <>{[5,12,19].map(cx=><circle key={cx} cx={cx} cy="12" r="1.7" fill="currentColor" stroke="none"/>)}</>,
 close: <path d="m6 6 12 12M6 18 18 6"/>,
};

export default function AnnotationIcon({name,className=''}:{name:AnnotationIconName;className?:string}){
 return <svg className={`annotation-icon ${className}`.trim()} data-icon={name} xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{artwork[name]}</svg>;
}
