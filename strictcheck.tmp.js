const fs=require('fs');const css=fs.readFileSync('styles.css','utf8');
const csstree=require('css-tree');let errs=0;
csstree.parse(css,{positions:true,onParseError(e){errs++;console.log('PARSE ERROR:',e.message,'line',e.line,'col',e.column);}});
console.log(errs===0?'parse ok':'parse errors: '+errs);
// simulate browser @media nesting support check
