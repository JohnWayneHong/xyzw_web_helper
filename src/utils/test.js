// 在浏览器控制台中逐行执行以下代码

// 首先定义解码所需的函数和类
const bon = {
  decode: (bytes) => {
    class DataReader {
      constructor(bytes) {
        this._data = bytes || new Uint8Array(0);
        this.position = 0;
      }

      readUInt8() {
        if (this.position >= this._data.length) return;
        return this._data[this.position++];
      }

      read7BitInt() {
        let value = 0;
        let shift = 0;
        let b = 0;
        let count = 0;
        do {
          if (count++ === 35) throw new Error('Format_Bad7BitInt32');
          b = this.readUInt8();
          value |= (b & 0x7F) << shift;
          shift += 7;
        } while ((b & 0x80) !== 0);
        return value >>> 0;
      }

      readUTF() {
        const len = this.read7BitInt();
        return this.readUTFBytes(len);
      }

      readUTFBytes(length) {
        if (length === 0) return '';
        const str = new TextDecoder('utf8').decode(this._data.subarray(this.position, this.position + length));
        this.position += length;
        return str;
      }

      readInt32() {
        const v = this._data[this.position++] | (this._data[this.position++] << 8) | 
                  (this._data[this.position++] << 16) | (this._data[this.position++] << 24);
        return v | 0;
      }
    }

    class BonDecoder {
      constructor() {
        this.dr = new DataReader(bytes);
        this.strArr = [];
      }

      decode() {
        const tag = this.dr.readUInt8();
        switch (tag) {
          default:
            return null;
          case 0:
            return null;
          case 1:
            return this.dr.readInt32();
          case 5: {
            const s = this.dr.readUTF();
            this.strArr.push(s);
            return s;
          }
          case 6:
            return this.dr.readUInt8() === 1;
          case 8: {
            const count = this.dr.read7BitInt();
            const obj = {};
            for (let i = 0; i < count; i++) {
              const k = this.decode();
              const v = this.decode();
              obj[k] = v;
            }
            return obj;
          }
          case 9: {
            const len = this.dr.read7BitInt();
            const arr = new Array(len);
            for (let i = 0; i < len; i++) arr[i] = this.decode();
            return arr;
          }
          case 99:
            return this.strArr[this.dr.read7BitInt()];
        }
      }
    }

    const decoder = new BonDecoder();
    return decoder.decode();
  }
};

// "x"解密函数
function decryptX(data) {
  const t = ((data[2] >> 6 & 1) << 7) | ((data[2] >> 4 & 1) << 6) | ((data[2] >> 2 & 1) << 5) | ((data[2] & 1) << 4) |
            ((data[3] >> 6 & 1) << 3) | ((data[3] >> 4 & 1) << 2) | ((data[3] >> 2 & 1) << 1) | (data[3] & 1);
  for (let n = data.length; --n >= 4; ) data[n] ^= t;
  return data.subarray(4);
}

// 解码你提供的数据
const hexString = '70 78 AE 73 25 29 28 2E 4E 40 49 28 25 72 5E 54 5E 02 4C 4E 46 28 2E 4C 4E 46 2C 2C 2D 2D 2D 28 2E 5E 48 5C 2C 2D 2D 2D 2D 28 29 59 44 40 48 2F 96 4E 18 00 B4 2C 2D 2D';
const dataArray = new Uint8Array(hexString.split(' ').map(hex => parseInt(hex, 16)));

// 先解密
const decrypted = decryptX(dataArray);
console.log('解密后的数据:', decrypted);

// 再解码
const decoded = bon.decode(decrypted);
console.log('最终解码结果:', decoded);

//用于复制到浏览器控制台 获取解密数据 替换hexString 即可获取解密数据