import type {Stroke} from './annotations';
type Props={stroke:Stroke;width?:number;height?:number};
export default function StrokeGraphic({stroke:s,width=1000,height=1000}:Props){
 const a=s.points[0],b=s.points.at(-1);if(!a||!b)return null;
 const x=a.x*1000,y=a.y*1000,bx=b.x*1000,by=b.y*1000;
 const weight=s.width||3,props={stroke:s.color,strokeWidth:s.tool==='highlighter'?weight*4:weight,fill:'none',strokeLinecap:'round' as const,strokeLinejoin:'round' as const,vectorEffect:'non-scaling-stroke'};
 if(s.tool==='text')return <text x="0" y="0" transform={`translate(${x} ${y}) scale(${1000/Math.max(1,width)} ${1000/Math.max(1,height)})`} fontSize={16+weight} fontFamily="sans-serif" fill={s.color} stroke={s.color==='#ffffff'?'#111827':'#fff'} strokeWidth="2" paintOrder="stroke" style={{userSelect:'none'}}>{s.text}</text>;
 if(s.tool==='rectangle')return <rect {...props} x={Math.min(x,bx)} y={Math.min(y,by)} width={Math.abs(bx-x)} height={Math.abs(by-y)}/>;
 if(s.tool==='ellipse')return <ellipse {...props} cx={(x+bx)/2} cy={(y+by)/2} rx={Math.abs(bx-x)/2} ry={Math.abs(by-y)/2}/>;
 if(s.tool==='line'||s.tool==='arrow'){
  const angle=Math.atan2((by-y)*height,(bx-x)*width),size=10+weight;
  const ends=[-.5,.5].map(delta=>`${bx-Math.cos(angle+delta)*size*1000/Math.max(1,width)},${by-Math.sin(angle+delta)*size*1000/Math.max(1,height)}`);
  return <g><line {...props} x1={x} y1={y} x2={bx} y2={by}/>{s.tool==='arrow'&&<polyline {...props} points={`${ends[0]} ${bx},${by} ${ends[1]}`}/>}</g>;
 }
 const graphic=s.points.length===1?<circle cx={x} cy={y} r="0.1" {...props} strokeWidth={weight+1}/>:<polyline {...props} points={s.points.map(p=>`${p.x*1000},${p.y*1000}`).join(' ')}/>;
 return s.tool==='highlighter'?<g opacity="0.32">{graphic}</g>:graphic;
}
