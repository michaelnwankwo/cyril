const fs=require("fs"),{JSDOM}=require("jsdom");
let navTo=null;
const html=fs.readFileSync("index.html","utf8");
const dom=new JSDOM(html,{runScripts:"outside-only",url:"https://cyrilfoods.netlify.app/index.html",pretendToBeVisual:true,
  beforeParse(w){ w.__navTo=()=>navTo; Object.defineProperty(w,"__setNav",{value:v=>{navTo=v;}}); }});
(async()=>{
 const w=dom.window;
 // wrap location.href setter
 try{const L=w.location;Object.defineProperty(L,"href",{configurable:true,set(v){navTo=v;},get(){return navTo||"https://cyrilfoods.netlify.app/index.html";}});}catch(e){console.log("loc wrap:",e.message);}
 w.eval(fs.readFileSync("config.js","utf8"));
 w.eval(fs.readFileSync("catalog.js","utf8"));
 w.fetch=(u,opt)=>{opt=opt||{};
   if(String(u).endsWith("/api/kitchen/login")){const pin=JSON.parse(opt.body).pin;
     return Promise.resolve({ok:pin==="1234",status:pin==="1234"?200:401,headers:{get:()=>"application/json"},
       json:()=>pin==="1234"?Promise.resolve({token:"TOK.ABC",expiresIn:86400}):Promise.resolve({message:"Incorrect kitchen passcode."})});}
   return Promise.resolve({ok:true,status:200,headers:{get:()=>"application/json"},json:()=>Promise.resolve({manualClosed:false,outOfStock:[],status:"ok"})});};
 w.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}};
 w.HTMLElement.prototype.getBoundingClientRect=function(){return{left:0,top:0,width:1,height:1};};
 w.eval(fs.readFileSync("app.js","utf8"));
 await new Promise(r=>setTimeout(r,200));
 const pin=w.document.getElementById("staffPin"), form=w.document.getElementById("staffForm");
 pin.value="1234";
 form.dispatchEvent(new w.Event("submit",{bubbles:true,cancelable:true}));
 await new Promise(r=>setTimeout(r,1000));
 console.log("localStorage token after correct PIN:", w.localStorage.getItem("cyrils_kitchen_token"));
 console.log("note:", w.document.getElementById("staffNote").textContent);
 console.log("redirected to:", navTo);
})();
