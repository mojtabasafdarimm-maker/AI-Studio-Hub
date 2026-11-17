import { createRequire as __ombCreateRequire } from "node:module";
const require = __ombCreateRequire(import.meta.url);
import{createConnection}from"node:net";var path=process.env.OMB_CODEX_AUTH_SOCKET,secret=process.env.OMB_CODEX_AUTH_SECRET;(!path||!secret)&&process.exit(1);var socket=createConnection(path);socket.setTimeout(55e3,()=>socket.destroy());socket.on("connect",()=>socket.write(`${secret}
`));socket.on("error",()=>{process.exitCode=1});var response="";socket.on("data",data=>{response+=data.toString(),response.length>16384&&socket.destroy()});socket.on("close",()=>{if(!response||response.length>16384){process.exitCode=1;return}process.stdout.write(response)});
