/* Warmly offline QR encoder. Byte mode, EC level L, versions 1-10.
   Self-contained, runs entirely in the browser. Nothing leaves the device.
   window.QR.matrix(text) -> { size, modules:[[0|1]] }  (or null if too big). */
window.QR = (function(){
  var EXP = new Array(256), LOG = new Array(256);
  (function(){ var x=1; for(var i=0;i<255;i++){ EXP[i]=x; LOG[x]=i; x<<=1; if(x&0x100) x^=0x11d; } EXP[255]=1; })();
  function mul(a,b){ return (a===0||b===0)?0:EXP[(LOG[a]+LOG[b])%255]; }
  function rsGen(d){ var g=[1]; for(var i=0;i<d;i++){ var ng=new Array(g.length+1); for(var j=0;j<ng.length;j++) ng[j]=0; for(var j=0;j<g.length;j++){ ng[j]^=g[j]; ng[j+1]^=mul(g[j],EXP[i]); } g=ng; } return g; }
  function rsEnc(data,ec){ var g=rsGen(ec), res=data.slice(); for(var i=0;i<ec;i++) res.push(0); for(var i=0;i<data.length;i++){ var c=res[i]; if(c){ for(var j=0;j<g.length;j++) res[i+j]^=mul(g[j],c); } } return res.slice(data.length); }

  /* EC level L block structure for versions 1..10: [ecPerBlock, [[numBlocks, dataPerBlock], ...]] */
  var ECB = {1:[7,[[1,19]]],2:[10,[[1,34]]],3:[15,[[1,55]]],4:[20,[[1,80]]],5:[26,[[1,108]]],6:[18,[[2,68]]],7:[20,[[2,78]]],8:[24,[[2,97]]],9:[30,[[2,116]]],10:[18,[[2,68],[2,69]]]};
  var ALIGN = {1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]};
  function dataCap(v){ var n=0; ECB[v][1].forEach(function(gp){ n+=gp[0]*gp[1]; }); return n; }

  function encode(text){
    var enc=unescape(encodeURIComponent(text)); var bytes=[]; for(var i=0;i<enc.length;i++) bytes.push(enc.charCodeAt(i)&0xff);
    var v=0; for(var ver=1; ver<=10; ver++){ var cnt=ver<10?8:16; if(bytes.length*8 + 4 + cnt <= dataCap(ver)*8){ v=ver; break; } }
    if(!v) return null;
    var cnt=v<10?8:16, bits=[];
    function put(val,len){ for(var i=len-1;i>=0;i--) bits.push((val>>i)&1); }
    put(4,4); put(bytes.length,cnt); for(var i=0;i<bytes.length;i++) put(bytes[i],8);
    var capBits=dataCap(v)*8; var t=capBits-bits.length; put(0, Math.min(4, t));
    while(bits.length%8) bits.push(0);
    var dcw=[]; for(var i=0;i<bits.length;i+=8){ var b=0; for(var j=0;j<8;j++) b=(b<<1)|bits[i+j]; dcw.push(b); }
    var pads=[0xEC,0x11], pi=0; while(dcw.length<dataCap(v)){ dcw.push(pads[pi++%2]); }
    var ecLen=ECB[v][0], blocks=[], idx=0;
    ECB[v][1].forEach(function(gp){ for(var b=0;b<gp[0];b++){ var data=dcw.slice(idx, idx+gp[1]); idx+=gp[1]; blocks.push({data:data, ec:rsEnc(data,ecLen)}); } });
    var maxD=0; blocks.forEach(function(b){ if(b.data.length>maxD) maxD=b.data.length; });
    var out=[];
    for(var i=0;i<maxD;i++) blocks.forEach(function(b){ if(i<b.data.length) out.push(b.data[i]); });
    for(var i=0;i<ecLen;i++) blocks.forEach(function(b){ out.push(b.ec[i]); });
    return {v:v, cw:out};
  }

  function maskFn(k,r,c){ switch(k){
    case 0: return (r+c)%2===0; case 1: return r%2===0; case 2: return c%3===0; case 3: return (r+c)%3===0;
    case 4: return (Math.floor(r/2)+Math.floor(c/3))%2===0; case 5: return ((r*c)%2)+((r*c)%3)===0;
    case 6: return (((r*c)%2)+((r*c)%3))%2===0; default: return (((r+c)%2)+((r*c)%3))%2===0; } }

  function fmtBits(mask){ /* EC=L (01), mask 3 bits -> 5 bits, BCH(15,5) gen 0x537, xor 0x5412 */
    var data=(0x01<<3)|mask; var rem=data<<10; for(var i=14;i>=10;i--){ if((rem>>i)&1) rem^=(0x537<<(i-10)); }
    return ((data<<10)|rem)^0x5412; }
  function verBits(v){ var rem=v<<12; for(var i=17;i>=12;i--){ if((rem>>i)&1) rem^=(0x1f25<<(i-12)); } return (v<<12)|rem; }

  function build(text){
    var e=encode(text); if(!e) return null; var v=e.v, size=17+4*v;
    var m=[], res=[]; for(var r=0;r<size;r++){ m.push(new Array(size).fill(0)); res.push(new Array(size).fill(false)); }
    function set(r,c,val){ if(r<0||c<0||r>=size||c>=size) return; m[r][c]=val?1:0; res[r][c]=true; }
    function finder(r,c){ for(var i=-1;i<=7;i++) for(var j=-1;j<=7;j++){ var on=(i>=0&&i<=6&&(j===0||j===6))||(j>=0&&j<=6&&(i===0||i===6))||(i>=2&&i<=4&&j>=2&&j<=4); set(r+i,c+j,on); } }
    finder(0,0); finder(0,size-7); finder(size-7,0);
    for(var i=8;i<size-8;i++){ if(!res[6][i]) set(6,i,i%2===0); if(!res[i][6]) set(i,6,i%2===0); }
    var ap=ALIGN[v]; for(var a=0;a<ap.length;a++) for(var b=0;b<ap.length;b++){ var ar=ap[a], ac=ap[b]; if(res[ar][ac]) continue; for(var i=-2;i<=2;i++) for(var j=-2;j<=2;j++){ set(ar+i,ac+j, Math.max(Math.abs(i),Math.abs(j))!==1); } }
    set(size-8,8,1);
    /* reserve format + version areas so data skips them */
    for(var i=0;i<=8;i++){ if(!res[8][i]) res[8][i]=true; if(!res[i][8]) res[i][8]=true; }
    for(var i=0;i<8;i++){ res[8][size-1-i]=true; res[size-1-i][8]=true; }
    if(v>=7){ for(var i=0;i<6;i++) for(var j=0;j<3;j++){ res[i][size-11+j]=true; res[size-11+j][i]=true; } }
    /* place data bits, zigzag from bottom-right */
    var bitsArr=[]; e.cw.forEach(function(b){ for(var i=7;i>=0;i--) bitsArr.push((b>>i)&1); });
    var bi=0, up=true;
    for(var col=size-1; col>0; col-=2){ if(col===6) col--;
      for(var k=0;k<size;k++){ var row=up?(size-1-k):k;
        for(var cc=0;cc<2;cc++){ var c2=col-cc; if(res[row][c2]) continue; m[row][c2]=bi<bitsArr.length?bitsArr[bi++]:0; }
      } up=!up;
    }
    /* try masks, score penalty, keep best */
    function penalty(mm){ var p=0, i,j,k;
      for(i=0;i<size;i++){ var rc=1, cc=1; for(j=1;j<size;j++){ if(mm[i][j]===mm[i][j-1]) rc++; else { if(rc>=5) p+=3+(rc-5); rc=1; } if(mm[j][i]===mm[j-1][i]) cc++; else { if(cc>=5) p+=3+(cc-5); cc=1; } } if(rc>=5) p+=3+(rc-5); if(cc>=5) p+=3+(cc-5); }
      for(i=0;i<size-1;i++) for(j=0;j<size-1;j++){ var x=mm[i][j]; if(x===mm[i][j+1]&&x===mm[i+1][j]&&x===mm[i+1][j+1]) p+=3; }
      var pat=[1,0,1,1,1,0,1];
      for(i=0;i<size;i++) for(j=0;j<size-6;j++){ var hok=true,vok=true; for(k=0;k<7;k++){ if(mm[i][j+k]!==pat[k]) hok=false; if(mm[j+k][i]!==pat[k]) vok=false; } if(hok) p+=40; if(vok) p+=40; }
      var dark=0; for(i=0;i<size;i++) for(j=0;j<size;j++) if(mm[i][j]) dark++;
      var pct=dark*100/(size*size); p+=Math.floor(Math.abs(pct-50)/5)*10;
      return p;
    }
    function applyMaskFmt(k){ var mm=[]; for(var r=0;r<size;r++) mm.push(m[r].slice());
      for(var r=0;r<size;r++) for(var c=0;c<size;c++){ if(!res[r][c] && maskFn(k,r,c)) mm[r][c]^=1; }
      var f=fmtBits(k);
      for(var i=0;i<15;i++){ var fb=(f>>i)&1;
        if(i<6) mm[i][8]=fb; else if(i<8) mm[i+1][8]=fb; else mm[size-15+i][8]=fb;
        if(i<8) mm[8][size-1-i]=fb; else if(i<9) mm[8][7]=fb; else mm[8][15-i-1]=fb;
      }
      mm[size-8][8]=1;
      if(v>=7){ var vb=verBits(v); for(var i=0;i<18;i++){ var bit=(vb>>i)&1; var r=Math.floor(i/3), c=i%3; mm[r][size-11+c]=bit; mm[size-11+c][r]=bit; } }
      return mm;
    }
    var best=null, bestP=1e18;
    for(var k=0;k<8;k++){ var mm=applyMaskFmt(k); var p=penalty(mm); if(p<bestP){ bestP=p; best=mm; } }
    return {size:size, modules:best};
  }

  return { matrix: build };
})();
