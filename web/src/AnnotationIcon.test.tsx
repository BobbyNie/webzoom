import {describe,it,expect} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import AnnotationIcon,{annotationIconNames} from './AnnotationIcon';

describe('custom annotation vectors',()=>{
 it.each(annotationIconNames)('%s renders scalable, decorative artwork without font symbols or remote assets',name=>{
  const svg=renderToStaticMarkup(<AnnotationIcon name={name}/>);
  expect(svg).toContain('viewBox="0 0 24 24"');
  expect(svg).toContain('width="20"');expect(svg).toContain('height="20"');
  expect(svg).toContain('aria-hidden="true"');expect(svg).toContain('focusable="false"');
  expect(svg).toContain('currentColor');expect(svg).toMatch(/<(path|rect|circle|ellipse) /);
  expect(svg).not.toMatch(/<(text|image|script)|href=|style=|<title|id=/);
 });
 it('keeps mouse, live pointing and drawn arrow structurally different',()=>{
  const mouse=renderToStaticMarkup(<AnnotationIcon name="view"/>);
  const pointer=renderToStaticMarkup(<AnnotationIcon name="pointer"/>);
  const arrow=renderToStaticMarkup(<AnnotationIcon name="arrow"/>);
  expect(mouse).toContain('fill="currentColor" stroke="none"');
  expect(pointer).toContain('<circle');expect(arrow).not.toContain('<circle');
  expect(arrow).not.toContain('fill="currentColor"');
  expect(new Set([mouse,pointer,arrow]).size).toBe(3);
 });
 it('uses unique geometry for every tool and utility',()=>{
  const shapes=annotationIconNames.map(name=>renderToStaticMarkup(<AnnotationIcon name={name}/>).replace(/data-icon="[^"]*"/g,''));
  expect(new Set(shapes).size).toBe(annotationIconNames.length);
 });
});
