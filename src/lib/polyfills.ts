import { Buffer as NodeBuffer } from 'buffer';

if (typeof global.Buffer === 'undefined') {
  global.Buffer = NodeBuffer;
}
