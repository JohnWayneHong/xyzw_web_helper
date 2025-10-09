<template>
  <div class="token-extractor-container">
    <!-- 上传区域 -->
    <div 
      class="upload-area"
      @click="handleUploadAreaClick"
    >
      <p class="upload-text">{{ loading ? '正在处理文件...' : '点击上传BIN文件' }}</p>
      <input 
        ref="fileInputRef" 
        type="file" 
        accept=".bin" 
        class="file-input" 
        @change="handleFileChange"
        @click.stop
        :disabled="loading"
      >
    </div>
    <!-- 文件信息 -->
    <div v-if="selectedFile" class="file-info">
      已选择: {{ selectedFile.name }}
    </div>

  </div>
</template>

<script setup>
import { ref } from 'vue';

// 定义emit以向父组件发送事件
const emit = defineEmits(['fileSelected', 'tokenExtracted']);

// 状态管理
const selectedFile = ref(null);
const extractedToken = ref('');
const wssLink = ref('');
const loading = ref(false);
const statusMessage = ref('');
const statusType = ref('');
const fileInputRef = ref();

// 处理上传区域点击
const handleUploadAreaClick = () => {
  fileInputRef.value?.click();
};

// 处理文件选择和自动处理
const handleFileChange = async (event) => {
  const target = event.target;
  if (target.files && target.files.length > 0) {
    selectedFile.value = target.files[0];
    // 向父组件发送文件选择事件和文件名
    emit('fileSelected', selectedFile.value.name);
    
    // 自动处理文件
    await processFile(selectedFile.value);
  }
};

// 处理文件并提取Token
const processFile = async (file) => {
  // 重置状态
  extractedToken.value = '';
  wssLink.value = '';
  
  // 设置加载状态
  loading.value = true;

  try {
    // 读取文件内容
    const arrayBuffer = await readFileAsArrayBuffer(file);
    
    // 配置请求
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://xxz-xyzw.hortorgames.com/login/authuser?_seq=1', true);
    xhr.responseType = 'arraybuffer';

    // 处理响应
    await new Promise(function(resolve, reject) {
      xhr.addEventListener('load', function() {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const responseBuffer = xhr.response;
           
            if (responseBuffer) {
              // 提取RoleToken
              extractRoleToken(responseBuffer);
              showStatus('Token提取成功！WSS链接已自动复制', 'success');
              resolve();
            } else {
              showStatus('上传成功，但响应为空', 'error');
              reject(new Error('响应为空'));
            }
          } catch (e) {
            showStatus('处理响应时出错: ' + e.message, 'error');
            reject(e);
          }
        } else {
          showStatus('上传失败: ' + xhr.statusText, 'error');
          reject(new Error('HTTP错误: ' + xhr.status));
        }
      });

      xhr.addEventListener('error', function() {
        showStatus('上传过程中发生错误', 'error');
        reject(new Error('网络错误'));
      });

      // 发送请求
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.send(arrayBuffer);
    });
  } catch (error) {
    console.error('处理失败:', error);

  } finally {
    loading.value = false;
  }
};

// 显示状态消息
const showStatus = (message, type = 'info') => {
  statusMessage.value = message;
  statusType.value = type;
  
  // 3秒后自动清除消息
  setTimeout(() => {
    statusMessage.value = '';
    statusType.value = '';
  }, 3000);
};

// 读取文件为ArrayBuffer
const readFileAsArrayBuffer = (file) => {
  return new Promise(function(resolve, reject) {
    const reader = new FileReader();
    reader.onload = function() {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
      } else {
        reject(new Error('无法读取文件内容'));
      }
    };
    reader.onerror = function() { reject(reader.error); };
    reader.readAsArrayBuffer(file);
  });
};

// 辅助函数：检查字符是否为Base64字符
const isBase64Char = (char) => {
  // Base64字符集: A-Z, a-z, 0-9, +, /, =
  return /[A-Za-z0-9+/=]/.test(char);
};

// 提取RoleToken
const extractRoleToken = (arrayBuffer) => {
  try {
    // 将ArrayBuffer转换为Uint8Array以便处理
    const bytes = new Uint8Array(arrayBuffer);

    // 转换为ASCII字符串以便搜索
    let asciiString = '';
    for (let i = 0; i < bytes.length; i++) {
      // 只转换可打印的ASCII字符（32-126）
      if (bytes[i] >= 32 && bytes[i] <= 126) {
        asciiString += String.fromCharCode(bytes[i]);
      } else {
        asciiString += '.'; // 用点号表示不可打印字符
      }
    }

     
    // 搜索Token的位置 - 查找 "Token" 字符串
    const tokenIndex = asciiString.indexOf('Token');
  
    if (tokenIndex !== -1) {
      // 找到Token标记，提取Token值
      // Token值通常跟在"Token"后面，我们需要找到Base64编码的部分
      let tokenStart = tokenIndex + 5; // "Token"长度为5
      
      // 跳过可能的非Base64字符，直到找到Base64字符
      while (tokenStart < asciiString.length) {
        const char = asciiString[tokenStart];
        if (isBase64Char(char)) {
          break;
        }
        tokenStart++;
      }
      
      // 提取Base64 Token
      let tokenEnd = tokenStart;
      while (tokenEnd < asciiString.length && isBase64Char(asciiString[tokenEnd])) {
        tokenEnd++;
      }
      
      const tokenValue = asciiString.substring(tokenStart, tokenEnd);
      
      if (tokenValue.length > 0) {
        extractedToken.value = tokenValue;
        
        // 生成并显示完整的WSS链接
        generateAndDisplayWssLink(tokenValue);

        

      } else {
        showStatus('找到Token标记但未找到Token值', 'error');
      }
    } else {
      showStatus('在响应中未找到Token标记', 'error');
    }
  } catch (error) {
    showStatus('提取Token时发生错误: ' + error.message, 'error');
  }
};

// 生成并显示完整的WSS链接
const generateAndDisplayWssLink = (token) => {
  // 生成随机的会话ID和连接ID
  const currentTime = Date.now();
  const sessId = currentTime * 100 + Math.floor(Math.random() * 100);
  const connId = currentTime + Math.floor(Math.random() * 10);
  
  // 构建WebSocket URL参数（注意sessId和connId是数字类型，不需要引号）
  const wssParams = '{"roleToken":"' + token + '","sessId":' + sessId + ',"connId":' + connId + ',"isRestore":0}';
  
  // 自动复制到剪贴板
  setTimeout(() => {
    if (wssParams) {
      
      copyToClipboard(wssParams, 'WSS链接已自动复制到剪贴板');
    }
  }, 100);

  // 向父组件发送token提取事件和wssParams
  emit('tokenExtracted', wssParams);
  console.log('wssParams', wssParams);
  
  
};

// 复制到剪贴板
const copyToClipboard = async (text, successMsg) => {
  try {
    await navigator.clipboard.writeText(text);
    showStatus(successMsg, 'success');
  } catch (err) {
    console.error('复制失败: ' + err.message);
    showStatus('复制失败', 'error');
  }
};
</script>

<style scoped>
.token-extractor-container {
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
}

.header-section {
  text-align: center;
  margin-bottom: 20px;
}

.header-section h2 {
  color: #2c3e50;
  font-size: 24px;
  margin: 0;
}

/* 上传区域样式 */
.upload-area {
  border: 2px dashed #ddd;
  border-radius: 8px;
  padding: 25px;
  margin-bottom: 15px;
  cursor: pointer;
  transition: all 0.3s;
  background-color: #f8f9fa;
  text-align: center;
  position: relative;
}

.upload-area:hover {
  border-color: #3498db;
  background-color: rgba(52, 152, 219, 0.05);
}

.upload-text {
  font-size: 16px;
  color: #34495e;
  margin: 0;
}

.file-input {
  position: absolute;
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
  opacity: 0;
  cursor: pointer;
}

/* 文件信息样式 */
.file-info {
  margin: 10px 0;
  padding: 10px;
  background-color: #e8f4fc;
  border-radius: 6px;
  font-size: 14px;
  color: #2c3e50;
}

/* 按钮样式 */
.btn {
  background: linear-gradient(135deg, #1a2980 0%, #26d0ce 100%);
  color: white;
  border: none;
  padding: 12px 20px;
  width: 100%;
  border-radius: 4px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  margin-top: 5px;
}

.btn:hover:not(:disabled) {
  opacity: 0.9;
}

.btn:disabled {
  background: #cccccc;
  cursor: not-allowed;
}

/* 状态消息样式 */
.status-message {
  padding: 10px;
  border-radius: 6px;
  margin: 10px 0;
  text-align: center;
  font-weight: 500;
}

.status-message.success {
  background-color: rgba(39, 174, 96, 0.15);
  color: #27ae60;
}

.status-message.error {
  background-color: rgba(231, 76, 60, 0.15);
  color: #e74c3c;
}

/* 结果区域样式 */
.result-container {
  margin-top: 20px;
  padding: 15px;
  background-color: #f8f9fa;
  border-radius: 8px;
}

.result-title {
  font-size: 16px;
  color: #2c3e50;
  margin-bottom: 10px;
  font-weight: 600;
}

.token-display {
  word-break: break-all;
  font-family: monospace;
  font-size: 14px;
  color: #27ae60;
  line-height: 1.5;
  padding: 10px;
  background-color: white;
  border-radius: 6px;
  border-left: 4px solid #27ae60;
  margin-bottom: 15px;
}

.wss-link-display {
  word-break: break-all;
  font-family: monospace;
  font-size: 14px;
  color: #2e7d32;
  line-height: 1.5;
  padding: 10px;
  background-color: white;
  border-radius: 6px;
  border-left: 4px solid #4caf50;
  margin-top: 10px;
}

.copy-btn {
  background: #27ae60;
  color: white;
  border: none;
  padding: 8px 15px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: background 0.3s;
  margin-top: 10px;
}

.copy-btn:hover {
  background: #219653;
}

.token-info {
  margin-top: 15px;
  padding: 15px;
  background-color: #e8f5e9;
  border-radius: 8px;
}

.token-info h3 {
  color: #2e7d32;
  margin-bottom: 10px;
  font-size: 16px;
  margin-top: 0;
}
</style>