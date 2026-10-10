import { createLab } from './engine.js';
let lab;
const ready=createLab().then(value=>lab=value);
let queue=Promise.resolve();
self.onmessage=({data})=>{
  queue=queue.then(async()=>{try{await ready;const result=data.action==='snapshot'?lab.snapshot():await lab.step(data.action,data.value);self.postMessage({id:data.id,result});}catch(error){self.postMessage({id:data.id,error:error.message});}});
};
