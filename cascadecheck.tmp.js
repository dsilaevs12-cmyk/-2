const fs=require('fs');const csstree=require('css-tree');
const css=fs.readFileSync('styles.css','utf8').replace(/^.*?\n.*?<style>\n/s,'').replace(/<\/style>[\s\S]*$/,'');
const ast=csstree.parse(css,{positions:true});
// collect all rules with their media/support context chain
const results=[];
function walk(node, ctx){
  node.children && node.children.forEach(child=>{
    if(child.type==='Atrule'){
      const name='@'+child.name;
      const prelude=child.prelude?csstree.generate(child.prelude):'';
      walk(child.block, ctx.concat([name+' '+prelude]));
    } else if(child.type==='Rule'){
      const sel=csstree.generate(child.prelude);
      if(/nav-item/.test(sel) && !/forced-colors/.test(ctx.join())){
        const decls=[];
        child.block.children.forEach(d=>{ if(d.type==='Declaration') decls.push(d.property+':'+csstree.generate(d.value).slice(0,60)); });
        results.push({sel:sel.slice(0,90), ctx:ctx.join(' | '), decls:decls.join('; ')});
      }
    }
  });
}
walk(ast,[]);
results.forEach((r,i)=>console.log(i+1,'CTX['+r.ctx+'] SEL['+r.sel+'] =>',r.decls));
