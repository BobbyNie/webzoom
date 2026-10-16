import type {BrowserPlan,BrowserSignal,BrowserOverview} from './browserRelayProtocol';
import type {AnnotationState,AnnotationEvent} from './annotations';
export interface User {id:string;name:string}
export interface Identity {user:User;csrf:string;expiresAt:string}
export interface Room {browserRelayMaxViewers?:number;browserRelayAvailable?:boolean;browserRelayEnabled?:boolean;id:string;ownerId:string;publisherId:string;epoch:number;active:boolean;createdAt:string;expiresAt:string;participants:User[];annotators?:string[];annotationRequests?:string[];quality?:number}
export interface Control {browserOverview?:BrowserOverview;browserPlan?:BrowserPlan;browserSignal?:BrowserSignal;annotation?:AnnotationEvent;annotations?:AnnotationState;error?:string;type:string;room?:Room;level?:number;clientTime?:number;serverTime?:number}
