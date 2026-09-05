const fs=require("fs"),{JSDOM}=require("jsdom");
function load(html,page){
 const dom=new JSDOM(fs.readFileSync(html,"utf8"),{runScripts:"outside-only",url:"https://cyrilfoods.netlify.app/"+page,pretendToBeVisual:true});
 const w=dom.window,d=w.document;const errors=[];w.addEventListener("error",e=>errors.push(e.message));
 w.fetch=(u,opt)=>{ // simulate backend
   if(String(u).endsWith("/api/kitchen/login")){const pin=JSON.parse(opt.body).pin;
     return Promise.resolve({ok:pin==="1234",status:pin==="1234"?200:401,headers:{get:()=>"application/json"},
       json:()=>pin==="1234"?Promise.resolve({token:"TOK."+Date.now(),expiresIn:86400}):Promise.resolve({message:"Incorrect kitchen passcode."})});}
   return Promise.resolve({ok:true,status:200,headers:{get:()=>"application/json"},json:()=>Promise.resolve({manualClosed:false,outOfStock:[]})});};
 w.EventSource=function(){this.close=()=>{};};
 w.AudioContext=function(){return{currentTime:0,createOscillator:()=>({connect(){},start(){},stop(){},frequency:{}}),createGain:()=>({connect(){},gain:{}}),destination:{}}};
 w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 w.HTMLElement.prototype.getBoundingClientRect=function(){return{left:0,top:0,width:100,height:100};};
 try{w.eval(fs.readFileSync("config.js","utf8"));w.eval(fs.readFileSync("catalog.js","utf8"));
 w.eval(fs.readFileSync(html==="kitchen.html"?"kitchen.js":"app.js","utf8"));}catch(e){errors.push("EVAL:"+e.message);}
 return new Promise(r=>setTimeout(()=>r({w,d,errors}),300));
}
(async()=>{
 // kitchen.html PIN gate
 const k=await load("kitchen.html","kitchen.html");
 const kd=k.d;
 const hasPinForm=!!kd.getElementById("pinForm"),hasPinInput=!!kd.getElementById("pinInput"),noEmail=!kd.getElementById("magicEmail");
 console.log("kitchen.html: pinForm",hasPinForm,"pinInput",hasPinInput,"no old email field",noEmail,"errors",k.errors);
 // simulate entering correct pin on kitchen
 kd.getElementById("pinInput").value="1234";
 kd.getElementById("pinForm").dispatchEvent(new k.w.Event("submit",{bubbles:true,cancelable:true}));
 await new Promise(r=>setTimeout(r,300));
 console.log("  after correct PIN -> token stored:", (k.w.localStorage.getItem("cyrils_kitchen_token")||"").slice(0,7)==="TOK.", "| gate hidden:", kd.getElementById("pinGate").style.display==="none");

 // index.html staff modal
 const i=await load("index.html","index.html");
 const id=i.d;
 const staffPin=!!id.getElementById("staffPin"), staffForm=!!id.getElementById("staffForm"), noStaffEmail=!id.getElementById("staffEmail");
 console.log("index.html: staffForm",staffForm,"staffPin",staffPin,"no old staffEmail",noStaffEmail,"errors",i.errors);
 // wrong then right
 id.getElementById("staffPin").value="9999";
 id.getElementById("staffForm").dispatchEvent(new i.w.Event("submit",{bubbles:true,cancelable:true}));
 await new Promise(r=>setTimeout(r,200));
 console.log("  wrong PIN note:", id.getElementById("staffNote").textContent);
 id.getElementById("staffPin").value="1234";
 let redirected=false;
 try{Object.defineProperty(i.w.location,"href",{set(v){redirected=v;}});}catch(e){}
 id.getElementById("staffForm").dispatchEvent(new i.w.Event("submit",{bubbles:true,cancelable:true}));
 await new Promise(r=>setTimeout(r,300));
 console.log("  correct PIN -> redirect to:", redirected, "| token:", (i.w.localStorage.getItem("cyrils_kitchen_token")||"").slice(0,7)==="TOK.");
})();
