import {defineStore} from 'pinia'
import {ref, computed} from 'vue'
import {bonProtocol, GameMessages, g_utils} from '../utils/bonProtocol.js'
import {XyzwWebSocketClient} from '../utils/xyzwWebSocket.js'
import {findAnswer} from '../utils/studyQuestionsFromJSON.js'
import {tokenLogger, wsLogger, gameLogger} from '../utils/logger.js'

/**
 * 重构后的Token管理存储
 * 以名称-token列表形式管理多个游戏角色
 */
export const useTokenStore = defineStore('tokens', () => {
    // 状态
    const gameTokens = ref(JSON.parse(localStorage.getItem('gameTokens') || '[]'))
    const selectedTokenId = ref(localStorage.getItem('selectedTokenId') || null)
    const wsConnections = ref({}) // WebSocket连接状态
    const connectionLocks = ref(new Map()) // 连接操作锁，防止竞态条件
    const activeConnections = ref(new Map()) // 跨标签页连接协调

    // 游戏数据存储
    const gameData = ref({
        roleInfo: null,
        legionInfo: null,
        presetTeam: null,
        studyStatus: {
            isAnswering: false,
            questionCount: 0,
            answeredCount: 0,
            status: '', // '', 'starting', 'answering', 'claiming_rewards', 'completed'
            timestamp: null
        },
        lastUpdated: null
    })

    // 计算属性
    const hasTokens = computed(() => gameTokens.value.length > 0)
    const selectedToken = computed(() =>
        gameTokens.value.find(token => token.id === selectedTokenId.value)
    )

    // 获取当前选中token的角色信息
    const selectedTokenRoleInfo = computed(() => {
        return gameData.value.roleInfo
    })

    // Token管理
    const addToken = (tokenData) => {
        const newToken = {
            id: 'token_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
            name: tokenData.name,
            token: tokenData.token, // 保存原始Base64 token
            wsUrl: tokenData.wsUrl || null, // 可选的自定义WebSocket URL
            server: tokenData.server || '',
            level: tokenData.level || 1,
            profession: tokenData.profession || '',
            createdAt: new Date().toISOString(),
            lastUsed: new Date().toISOString(),
            isActive: true,
            // URL获取相关信息
            sourceUrl: tokenData.sourceUrl || null, // Token来源URL（用于刷新）
            importMethod: tokenData.importMethod || 'manual' // 导入方式：manual 或 url
        }

        gameTokens.value.push(newToken)
        saveTokensToStorage()

        return newToken
    }

    const updateToken = (tokenId, updates) => {
        const index = gameTokens.value.findIndex(token => token.id === tokenId)
        if (index !== -1) {
            gameTokens.value[index] = {
                ...gameTokens.value[index],
                ...updates,
                updatedAt: new Date().toISOString()
            }
            saveTokensToStorage()
            return true
        }
        return false
    }

    const removeToken = (tokenId) => {
        gameTokens.value = gameTokens.value.filter(token => token.id !== tokenId)
        saveTokensToStorage()

        // 关闭对应的WebSocket连接
        if (wsConnections.value[tokenId]) {
            closeWebSocketConnection(tokenId)
        }

        // 如果删除的是当前选中token，清除选中状态
        if (selectedTokenId.value === tokenId) {
            selectedTokenId.value = null
            localStorage.removeItem('selectedTokenId')
        }

        return true
    }

    const selectToken = (tokenId, forceReconnect = false) => {
        const token = gameTokens.value.find(t => t.id === tokenId)
        if (!token) {
            return null
        }

        // 检查是否已经是当前选中的token
        const isAlreadySelected = selectedTokenId.value === tokenId
        const existingConnection = wsConnections.value[tokenId]
        const isConnected = existingConnection?.status === 'connected'
        const isConnecting = existingConnection?.status === 'connecting'

        tokenLogger.debug(`选择Token: ${tokenId}`, {
            isAlreadySelected,
            isConnected,
            isConnecting,
            forceReconnect
        })

        // 更新选中状态
        selectedTokenId.value = tokenId
        localStorage.setItem('selectedTokenId', tokenId)

        // 更新最后使用时间
        updateToken(tokenId, {lastUsed: new Date().toISOString()})

        // 智能连接判断
        const shouldCreateConnection =
            forceReconnect ||                    // 强制重连
            (!isAlreadySelected) ||              // 首次选择此token
            (!existingConnection) ||             // 没有现有连接
            (existingConnection.status === 'disconnected') ||  // 连接已断开
            (existingConnection.status === 'error')            // 连接出错

        if (shouldCreateConnection) {
            if (isAlreadySelected && !forceReconnect) {
                wsLogger.info(`Token已选中但无连接，创建新连接: ${tokenId}`)
            } else if (!isAlreadySelected) {
                wsLogger.info(`切换到新Token，创建连接: ${tokenId}`)
            } else if (forceReconnect) {
                wsLogger.info(`强制重连Token: ${tokenId}`)
            }

            // 创建WebSocket连接
            createWebSocketConnection(tokenId, token.token, token.wsUrl)
        } else {
            if (isConnected) {
                wsLogger.debug(`Token已连接，跳过连接创建: ${tokenId}`)
            } else if (isConnecting) {
                wsLogger.debug(`Token连接中，跳过连接创建: ${tokenId}`)
            } else {
                wsLogger.debug(`Token已选中且有连接，跳过连接创建: ${tokenId}`)
            }
        }

        return token
    }

    // 辅助函数：分析数据结构
    const analyzeDataStructure = (obj, depth = 0, maxDepth = 3) => {
        if (depth > maxDepth || !obj || typeof obj !== 'object') {
            return typeof obj
        }

        const structure = {}
        for (const [key, value] of Object.entries(obj)) {
            if (Array.isArray(value)) {
                structure[key] = `Array[${value.length}]${value.length > 0 ? `: ${analyzeDataStructure(value[0], depth + 1, maxDepth)}` : ''}`
            } else if (typeof value === 'object' && value !== null) {
                structure[key] = analyzeDataStructure(value, depth + 1, maxDepth)
            } else {
                structure[key] = typeof value
            }
        }
        return structure
    }

    // 辅助函数：尝试解析队伍数据
    const tryParseTeamData = (data, cmd) => {
        // 静默解析，不打印详细日志

        // 查找队伍相关字段
        const teamFields = []
        const scanForTeamData = (obj, path = '') => {
            if (!obj || typeof obj !== 'object') return

            for (const [key, value] of Object.entries(obj)) {
                const currentPath = path ? `${path}.${key}` : key

                if (key.toLowerCase().includes('team') ||
                    key.toLowerCase().includes('preset') ||
                    key.toLowerCase().includes('formation') ||
                    key.toLowerCase().includes('lineup')) {
                    teamFields.push({
                        path: currentPath,
                        key: key,
                        value: value,
                        type: typeof value,
                        isArray: Array.isArray(value)
                    })
                }

                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    scanForTeamData(value, currentPath)
                }
            }
        }

        scanForTeamData(data)

        if (teamFields.length > 0) {
            gameLogger.debug(`找到 ${teamFields.length} 个队伍相关字段:`, teamFields)

            // 尝试更新游戏数据
            teamFields.forEach(field => {
                if (field.key === 'presetTeamInfo' || field.path.includes('presetTeamInfo')) {
                    gameLogger.debug(`发现预设队伍信息，准备更新:`, field.value)
                    if (!gameData.value.presetTeam) {
                        gameData.value.presetTeam = {}
                    }
                    gameData.value.presetTeam.presetTeamInfo = field.value
                    gameData.value.lastUpdated = new Date().toISOString()
                }
            })
        } else {
            // 未找到队伍数据
        }
    }

    // 处理学习答题响应的核心函数
    const handleStudyResponse = async (tokenId, body) => {
        try {
            gameLogger.info('开始处理学习答题响应')

            const connection = wsConnections.value[tokenId]
            if (!connection || connection.status !== 'connected' || !connection.client) {
                gameLogger.error('WebSocket连接不可用，无法进行答题')
                return
            }

            // 获取题目列表和学习ID
            const questionList = body.questionList
            const studyId = body.role?.study?.id

            if (!questionList || !Array.isArray(questionList)) {
                gameLogger.error('未找到题目列表')
                return
            }

            if (!studyId) {
                gameLogger.error('未找到学习ID')
                return
            }

            gameLogger.info(`找到 ${questionList.length} 道题目，学习ID: ${studyId}`)

            // 更新答题状态
            gameData.value.studyStatus = {
                isAnswering: true,
                questionCount: questionList.length,
                answeredCount: 0,
                status: 'answering',
                timestamp: Date.now()
            }

            // 遍历题目并回答
            for (let i = 0; i < questionList.length; i++) {
                const question = questionList[i]
                const questionText = question.question
                const questionId = question.id

                gameLogger.debug(`题目 ${i + 1}: ${questionText.substring(0, 20)}...`)

                // 查找答案（异步）
                let answer = await findAnswer(questionText)

                if (answer === null) {
                    answer = 1
                    gameLogger.verbose(`未找到匹配答案，使用默认答案: ${answer}`)
                } else {
                    gameLogger.debug(`找到答案: ${answer}`)
                }

                // 发送答案
                try {
                    connection.client.send('study_answer', {
                        id: studyId,
                        option: [answer],
                        questionId: [questionId]
                    })
                    gameLogger.verbose(`已提交题目 ${i + 1} 的答案: ${answer}`)
                } catch (error) {
                    gameLogger.error(`提交答案失败 (题目 ${i + 1}):`, error)
                }

                // 更新已回答题目数量
                gameData.value.studyStatus.answeredCount = i + 1

                // 添加短暂延迟，避免请求过快
                if (i < questionList.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 100))
                }
            }

            // 等待一下让所有答案提交完成，然后领取奖励
            setTimeout(() => {
                gameLogger.info('开始领取答题奖励')

                // 更新状态为正在领取奖励
                gameData.value.studyStatus.status = 'claiming_rewards'

                // 领取所有等级的奖励 (1-10)
                const rewardPromises = []
                for (let rewardId = 1; rewardId <= 10; rewardId++) {
                    try {
                        const promise = connection.client.send('study_claimreward', {
                            rewardId: rewardId
                        })
                        rewardPromises.push(promise)
                        gameLogger.verbose(`已发送奖励领取请求: rewardId=${rewardId}`)
                    } catch (error) {
                        gameLogger.error(`发送奖励领取请求失败 (rewardId=${rewardId}):`, error)
                    }
                }

                gameLogger.info('一键答题完成！已尝试领取所有奖励')

                // 更新状态为完成
                gameData.value.studyStatus.status = 'completed'

                // 3秒后重置状态
                setTimeout(() => {
                    gameData.value.studyStatus = {
                        isAnswering: false,
                        questionCount: 0,
                        answeredCount: 0,
                        status: '',
                        timestamp: null
                    }
                }, 3000)

                // 更新游戏数据
                setTimeout(() => {
                    try {
                        connection.client.send('role_getroleinfo', {})
                        gameLogger.debug('已请求更新角色信息')
                    } catch (error) {
                        gameLogger.error('请求角色信息更新失败:', error)
                    }
                }, 1000)

            }, 500) // 延迟500ms后领取奖励

        } catch (error) {
            gameLogger.error('处理学习答题响应失败:', error)
        }
    }

    // 判断当前时间是否在本周内
    function isInCurrentWeek(timestamp, weekStart = 1) {
        // timestamp 单位：毫秒。如果是秒，先 *1000
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        // 当前星期几 (0=周日,1=周一,...6=周六)
        const currentWeekday = today.getDay();
        // 算出本周起始
        let diff = currentWeekday - weekStart;
        if (diff < 0) diff += 7;

        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - diff);

        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 7);

        const target = new Date(timestamp);
        return target >= startOfWeek && target < endOfWeek;
    }

    // 游戏消息处理
    const handleGameMessage = (tokenId, message) => {
        try {
            if (!message) { gameLogger.warn(`消息处理跳过 [${tokenId}]: 无效消息`); return }
            if (message.error) {
                const errText = String(message.error).toLowerCase()
                gameLogger.warn(`消息处理跳过 [${tokenId}]:`, message.error)
                if (errText.includes('token') && errText.includes('expired')) {
                    const conn = wsConnections.value[tokenId]
                    if (conn) {
                        conn.status = 'error'
                        conn.lastError = { timestamp: new Date().toISOString(), error: 'token expired' }
                    }
                    wsLogger.error(`Token 已过期，需要重新导入 [${tokenId}]`)
                }
                return
            }

            const cmd = message.cmd?.toLowerCase()
            // 优先使用rawData（ProtoMsg自动解码），然后decodedBody（手动解码），最后body（原始数据）
            const body = message.rawData !== undefined ? message.rawData :
                message.decodedBody !== undefined ? message.decodedBody :
                    message.body

            gameLogger.gameMessage(tokenId, cmd, !!body)

            // 过滤塔相关消息的详细打印

            // 处理角色信息 - 支持多种可能的响应命令
            if (cmd === 'role_getroleinfo' || cmd === 'role_getroleinforesp' || cmd.includes('role') && cmd.includes('info')) {
                gameLogger.debug(`角色信息响应: ${tokenId}`)

                if (body) {
                    gameData.value.roleInfo = body
                    gameData.value.lastUpdated = new Date().toISOString()
                    gameLogger.verbose('角色信息已更新')

                    // 详细打印角色信息 - 添加日志查看获取的数据
                    // 清理详细控制台输出，保留必要的状态更新

                    // 检查答题完成状态
                    if (body.role?.study?.maxCorrectNum !== undefined) {
                        const maxCorrectNum = body.role.study.maxCorrectNum
                        const beginTime = body.role.study.beginTime
                        const isStudyCompleted = maxCorrectNum >= 10 && isInCurrentWeek(beginTime*1000)

                        // 更新答题完成状态
                        if (!gameData.value.studyStatus) {
                            gameData.value.studyStatus = {}
                        }
                        gameData.value.studyStatus.isCompleted = isStudyCompleted
                        gameData.value.studyStatus.maxCorrectNum = maxCorrectNum

                        gameLogger.info(`答题状态更新: maxCorrectNum=${maxCorrectNum}, 完成状态=${isStudyCompleted}`)
                    }

                    // 检查塔信息
                    if (body.role?.tower) {
                        // 塔信息已更新
                    }
                } else {
                    gameLogger.debug('角色信息响应为空')
                }
            }

            // 处理军团信息
            else if (cmd === 'legion_getinfo') {
                if (body) {
                    gameData.value.legionInfo = body
                    gameLogger.verbose('军团信息已更新')
                }
            }

            // 处理队伍信息 - 支持多种队伍相关响应
            else if (cmd === 'presetteam_getinfo' || cmd === 'presetteam_getinforesp' ||
                cmd === 'presetteam_setteam' || cmd === 'presetteam_setteamresp' ||
                cmd === 'presetteam_saveteam' || cmd === 'presetteam_saveteamresp' ||
                cmd === 'role_gettargetteam' || cmd === 'role_gettargetteamresp' ||
                (cmd && cmd.includes('presetteam')) || (cmd && cmd.includes('team'))) {
                gameLogger.debug(`队伍信息响应: ${tokenId} ${cmd}`)

                if (body) {
                    // 更新队伍数据
                    if (!gameData.value.presetTeam) {
                        gameData.value.presetTeam = {}
                    }

                    // 根据不同的响应类型处理数据
                    if (cmd.includes('getteam')) {
                        // 获取队伍信息响应
                        gameData.value.presetTeam = {...gameData.value.presetTeam, ...body}
                    } else if (cmd.includes('setteam') || cmd.includes('saveteam')) {
                        // 设置/保存队伍响应 - 可能只返回确认信息
                        if (body.presetTeamInfo) {
                            gameData.value.presetTeam.presetTeamInfo = body.presetTeamInfo
                        }
                        // 合并其他队伍相关数据
                        Object.keys(body).forEach(key => {
                            if (key.includes('team') || key.includes('Team')) {
                                gameData.value.presetTeam[key] = body[key]
                            }
                        })
                    } else {
                        // 其他队伍相关响应
                        gameData.value.presetTeam = {...gameData.value.presetTeam, ...body}
                    }

                    gameData.value.lastUpdated = new Date().toISOString()
                    gameLogger.verbose('队伍信息已更新')

                    // 简化队伍数据结构日志
                    if (gameData.value.presetTeam.presetTeamInfo) {
                        const teamCount = Object.keys(gameData.value.presetTeam.presetTeamInfo).length
                        gameLogger.debug(`队伍数量: ${teamCount}`)
                    }
                } else {
                    gameLogger.debug('队伍信息响应为空')
                }
            }

            // 处理爬塔响应（静默处理，保持功能）
            else if (cmd === 'fight_starttower' || cmd === 'fight_starttowerresp') {
                if (body) {
                    // 判断爬塔结果
                    const battleData = body.battleData
                    if (battleData) {
                        const curHP = battleData.result?.sponsor?.ext?.curHP
                        const isSuccess = curHP > 0

                        // 保存爬塔结果到gameData中，供组件使用
                        if (!gameData.value.towerResult) {
                            gameData.value.towerResult = {}
                        }
                        gameData.value.towerResult = {
                            success: isSuccess,
                            curHP: curHP,
                            towerId: battleData.options?.towerId,
                            timestamp: Date.now()
                        }
                        gameData.value.lastUpdated = new Date().toISOString()

                        if (isSuccess) {
                            // 检查是否需要自动领取奖励
                            const towerId = battleData.options?.towerId
                            if (towerId !== undefined) {
                                const layer = towerId % 10
                                const floor = Math.floor(towerId / 10)

                                // 如果是新层数的第一层(layer=0)，检查是否有奖励可领取
                                if (layer === 0) {
                                    setTimeout(() => {
                                        const connection = wsConnections.value[tokenId]
                                        if (connection && connection.status === 'connected' && connection.client) {
                                            // 检查角色信息中的奖励状态
                                            const roleInfo = gameData.value.roleInfo
                                            const towerRewards = roleInfo?.role?.tower?.reward

                                            if (towerRewards && !towerRewards[floor]) {
                                                // 保存奖励信息
                                                gameData.value.towerResult.autoReward = true
                                                gameData.value.towerResult.rewardFloor = floor
                                                connection.client.send('tower_claimreward', {rewardId: floor})
                                            }
                                        }
                                    }, 1500)
                                }
                            }
                        }
                    }

                    // 爬塔后立即更新角色信息和塔信息
                    setTimeout(() => {
                        try {
                            const connection = wsConnections.value[tokenId]
                            if (connection && connection.status === 'connected' && connection.client) {
                                connection.client.send('role_getroleinfo', {})
                            }
                        } catch (error) {
                            // 忽略更新数据错误
                        }
                    }, 1000)
                }
            }

            // 处理奖励领取响应（静默处理）
            else if (cmd === 'tower_claimreward' || cmd === 'tower_claimrewardresp') {
                if (body) {
                    // 奖励领取成功后更新角色信息
                    setTimeout(() => {
                        const connection = wsConnections.value[tokenId]
                        if (connection && connection.status === 'connected' && connection.client) {
                            connection.client.send('role_getroleinfo', {})
                        }
                    }, 500)
                }
            }

            // 处理学习答题响应 - 一键答题功能
            else if (cmd === 'studyresp' || cmd === 'study_startgame' || cmd === 'study_startgameresp') {
                if (body) {
                    gameLogger.info(`学习答题响应: ${tokenId}`)
                    handleStudyResponse(tokenId, body)
                }
            }

            // 处理加钟相关响应
            else if (cmd === 'system_mysharecallback' || cmd === 'syncresp' || cmd === 'system_claimhangupreward' || cmd === 'system_claimhanguprewardresp') {
                gameLogger.debug(`加钟/挂机响应: ${tokenId} ${cmd}`)

                // 加钟操作完成后，延迟更新角色信息
                if (cmd === 'syncresp' || cmd === 'system_mysharecallback') {
                    setTimeout(() => {
                        const connection = wsConnections.value[tokenId]
                        if (connection && connection.status === 'connected' && connection.client) {
                            connection.client.send('role_getroleinfo', {})
                        }
                    }, 800)
                }

                // 挂机奖励领取完成后更新角色信息
                if (cmd === 'system_claimhanguprewardresp') {
                    setTimeout(() => {
                        const connection = wsConnections.value[tokenId]
                        if (connection && connection.status === 'connected' && connection.client) {
                            connection.client.send('role_getroleinfo', {})
                        }
                    }, 500)
                }
            }

            // 处理心跳响应（静默处理，不打印日志）
            else if (cmd === '_sys/ack') {
                // 心跳响应 - 静默处理

            }

            // 处理其他消息
            else {
                gameLogger.verbose(`其他消息: ${tokenId} ${cmd}`)

                // 特别关注队伍相关的未处理消息
                if (cmd && (cmd.includes('team') || cmd.includes('preset') || cmd.includes('formation'))) {
                    gameLogger.debug(`未处理队伍消息: ${tokenId} ${cmd}`)

                    // 尝试自动解析队伍数据
                    if (body && typeof body === 'object') {
                        tryParseTeamData(body, cmd)
                    }
                }

                // 特别关注塔相关的未处理消息（静默处理）
                if (cmd && cmd.includes('tower')) {
                    // 未处理塔消息
                }
            }

        } catch (error) {
            gameLogger.error(`处理消息失败 [${tokenId}]:`, error)
        }
    }

    // 验证token有效性
    const validateToken = (token) => {
        if (!token) return false
        if (typeof token !== 'string') return false
        if (token.trim().length === 0) return false
        // 简单检查：token应该至少有一定长度
        if (token.trim().length < 10) return false
        return true
    }

    // Base64解析功能（增强版）
    const parseBase64Token = (base64String) => {
        try {
            // 输入验证
            if (!base64String || typeof base64String !== 'string') {
                throw new Error('Token字符串无效')
            }

            // 移除可能的前缀和空格
            const cleanBase64 = base64String.replace(/^data:.*base64,/, '').trim()

            if (cleanBase64.length === 0) {
                throw new Error('Token字符串为空')
            }

            // 解码base64
            let decoded
            try {
                decoded = atob(cleanBase64)
            } catch (decodeError) {
                // 如果不是有效的Base64，作为纯文本token处理
                decoded = base64String.trim()
            }

            // 尝试解析为JSON
            let tokenData
            try {
                tokenData = JSON.parse(decoded)
            } catch {
                // 不是JSON格式，作为纯token处理
                tokenData = {token: decoded}
            }

            // 提取实际token
            const actualToken = tokenData.token || tokenData.gameToken || decoded

            // 验证token有效性
            if (!validateToken(actualToken)) {
                throw new Error(`提取的token无效: "${actualToken}"`)
            }

            return {
                success: true,
                data: {
                    ...tokenData,
                    actualToken // 添加提取出的实际token
                }
            }
        } catch (error) {
            return {
                success: false,
                error: '解析失败：' + error.message
            }
        }
    }

    const importBase64Token = (name, base64String, additionalInfo = {}) => {
        const parseResult = parseBase64Token(base64String)

        if (!parseResult.success) {
            return {
                success: false,
                error: parseResult.error,
                message: `Token "${name}" 导入失败: ${parseResult.error}`
            }
        }

        const tokenData = {
            name,
            token: parseResult.data.actualToken, // 使用验证过的实际token
            ...additionalInfo,
            ...parseResult.data // 解析出的数据覆盖手动输入
        }

        try {
            const newToken = addToken(tokenData)

            // 添加更多验证信息到成功消息
            const tokenInfo = parseResult.data.actualToken
            const displayToken = tokenInfo.length > 20 ?
                `${tokenInfo.substring(0, 10)}...${tokenInfo.substring(tokenInfo.length - 6)}` :
                tokenInfo

            return {
                success: true,
                token: newToken,
                tokenName: name,
                message: `Token "${name}" 导入成功`,
                details: `实际Token: ${displayToken}`
            }
        } catch (error) {
            return {
                success: false,
                error: error.message,
                message: `Token "${name}" 添加失败: ${error.message}`
            }
        }
    }

    // 连接管理辅助函数
    const generateSessionId = () => 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
    const currentSessionId = generateSessionId()

    // 获取连接锁
    const acquireConnectionLock = async (tokenId, operation = 'connect') => {
        const lockKey = `${tokenId}_${operation}`
        if (connectionLocks.value.has(lockKey)) {
            wsLogger.debug(`等待连接锁释放: ${tokenId} (${operation})`)
            // 等待现有操作完成，最多等待10秒
            let attempts = 0
            while (connectionLocks.value.has(lockKey) && attempts < 100) {
                await new Promise(resolve => setTimeout(resolve, 100))
                attempts++
            }
            if (connectionLocks.value.has(lockKey)) {
                wsLogger.warn(`连接锁等待超时: ${tokenId} (${operation})`)
                return false
            }
        }

        connectionLocks.value.set(lockKey, {
            tokenId,
            operation,
            timestamp: Date.now(),
            sessionId: currentSessionId
        })
        wsLogger.connectionLock(tokenId, operation, true)
        return true
    }

    // 释放连接锁
    const releaseConnectionLock = (tokenId, operation = 'connect') => {
        const lockKey = `${tokenId}_${operation}`
        if (connectionLocks.value.has(lockKey)) {
            connectionLocks.value.delete(lockKey)
            wsLogger.connectionLock(tokenId, operation, false)
        }
    }

    // 更新跨标签页连接状态
    const updateCrossTabConnectionState = (tokenId, action, sessionId = currentSessionId) => {
        const storageKey = `ws_connection_${tokenId}`
        const state = {
            action, // 'connecting', 'connected', 'disconnecting', 'disconnected'
            sessionId,
            timestamp: Date.now(),
            url: window.location.href
        }

        try {
            localStorage.setItem(storageKey, JSON.stringify(state))
            activeConnections.value.set(tokenId, state)
        } catch (error) {
            wsLogger.warn('无法更新跨标签页连接状态:', error)
        }
    }

    // 检查是否有其他标签页的活跃连接
    const checkCrossTabConnection = (tokenId) => {
        const storageKey = `ws_connection_${tokenId}`
        try {
            const stored = localStorage.getItem(storageKey)
            if (stored) {
                const state = JSON.parse(stored)
                const isRecent = (Date.now() - state.timestamp) < 30000 // 30秒内的状态认为是活跃的
                const isDifferentSession = state.sessionId !== currentSessionId

                if (isRecent && isDifferentSession && (state.action === 'connecting' || state.action === 'connected')) {
                    wsLogger.debug(`检测到其他标签页的活跃连接: ${tokenId}`)
                    return state
                }
            }
        } catch (error) {
            wsLogger.warn('检查跨标签页连接状态失败:', error)
        }
        return null
    }

    // WebSocket连接管理（重构版 - 防重连）
    const createWebSocketConnection = async (tokenId, base64Token, customWsUrl = null) => {
        wsLogger.info(`开始创建连接: ${tokenId}`)

        // 1. 获取连接锁，防止竞态条件
        const lockAcquired = await acquireConnectionLock(tokenId, 'connect')
        if (!lockAcquired) {
            wsLogger.error(`无法获取连接锁: ${tokenId}`)
            return null
        }

        try {
            // 2. 检查跨标签页连接状态
            const crossTabState = checkCrossTabConnection(tokenId)
            if (crossTabState) {
                wsLogger.debug(`跳过创建，其他标签页已有连接: ${tokenId}`)
                releaseConnectionLock(tokenId, 'connect')
                return null
            }

            // 3. 更新跨标签页状态为连接中
            updateCrossTabConnectionState(tokenId, 'connecting')

            // 4. 如果存在现有连接，先优雅关闭
            if (wsConnections.value[tokenId]) {
                wsLogger.debug(`优雅关闭现有连接: ${tokenId}`)
                await closeWebSocketConnectionAsync(tokenId)
            }

            // 5. 解析token
            const parseResult = parseBase64Token(base64Token)
            let actualToken
            if (parseResult.success) {
                actualToken = parseResult.data.actualToken
            } else {
                if (validateToken(base64Token)) {
                    actualToken = base64Token
                } else {
                    throw new Error(`Token无效: ${parseResult.error}`)
                }
            }


            // 6. 构建WebSocket URL
            // 使用固定的WebSocket基础地址，将token带入占位符
            // const baseWsUrl = 'wss://xxz-xyzw.hortorgames.com/agent?p=%s&e=x&lang=chinese'
            const baseWsUrl = 'ws://47.112.213.220:8001/agent?p=%s&e=x&lang=chinese'
            const wsUrl = customWsUrl || baseWsUrl.replace('%s', encodeURIComponent(actualToken))

            wsLogger.debug(`Token: ${actualToken.substring(0, 10)}...${actualToken.slice(-4)}`)

            // 7. 创建新的WebSocket客户端（增强版）
            const wsClient = new XyzwWebSocketClient({
                url: wsUrl,
                utils: g_utils,
                heartbeatMs: 5000
            })

            // 8. 设置连接状态（带会话ID）
            wsConnections.value[tokenId] = {
                client: wsClient,
                status: 'connecting',
                tokenId,
                wsUrl,
                actualToken,
                sessionId: currentSessionId,
                connectedAt: null,
                lastMessage: null,
                lastError: null,
                reconnectAttempts: 0
            }

            // 9. 设置事件监听（增强版）
            wsClient.onConnect = () => {
                wsLogger.wsConnect(tokenId)
                if (wsConnections.value[tokenId]) {
                    wsConnections.value[tokenId].status = 'connected'
                    wsConnections.value[tokenId].connectedAt = new Date().toISOString()
                    wsConnections.value[tokenId].reconnectAttempts = 0
                }
                updateCrossTabConnectionState(tokenId, 'connected')
                releaseConnectionLock(tokenId, 'connect')
            }

            wsClient.onDisconnect = (event) => {
                const reason = event.code === 1006 ? '异常断开' : event.reason || ''
                wsLogger.wsDisconnect(tokenId, reason)
                if (wsConnections.value[tokenId]) {
                    wsConnections.value[tokenId].status = 'disconnected'
                }
                updateCrossTabConnectionState(tokenId, 'disconnected')
            }

            wsClient.onError = (error) => {
                wsLogger.wsError(tokenId, error)
                if (wsConnections.value[tokenId]) {
                    wsConnections.value[tokenId].status = 'error'
                    wsConnections.value[tokenId].lastError = {
                        timestamp: new Date().toISOString(),
                        error: error.toString(),
                        url: wsUrl
                    }
                }
                releaseConnectionLock(tokenId, 'connect')
            }

            // 10. 设置消息监听
            wsClient.setMessageListener((message) => {
                const cmd = message?.cmd || 'unknown'
                wsLogger.wsMessage(tokenId, cmd, true)

                if (wsConnections.value[tokenId]) {
                    wsConnections.value[tokenId].lastMessage = {
                        timestamp: new Date().toISOString(),
                        data: message,
                        cmd: message?.cmd
                    }
                }

                handleGameMessage(tokenId, message)
            })

            // 11. 初始化连接
            wsClient.init()

            wsLogger.verbose(`WebSocket客户端创建成功: ${tokenId}`)
            return wsClient

        } catch (error) {
            wsLogger.error(`创建连接失败 [${tokenId}]:`, error)
            updateCrossTabConnectionState(tokenId, 'disconnected')
            releaseConnectionLock(tokenId, 'connect')
            return null
        }
    }

    // 异步版本的关闭连接（优雅关闭）
    const closeWebSocketConnectionAsync = async (tokenId) => {
        const lockAcquired = await acquireConnectionLock(tokenId, 'disconnect')
        if (!lockAcquired) {
            wsLogger.warn(`无法获取断开连接锁: ${tokenId}`)
            return
        }

        try {
            const connection = wsConnections.value[tokenId]
            if (connection && connection.client) {
                wsLogger.debug(`开始优雅关闭连接: ${tokenId}`)

                connection.status = 'disconnecting'
                updateCrossTabConnectionState(tokenId, 'disconnecting')

                connection.client.disconnect()

                // 等待连接完全关闭
                await new Promise(resolve => {
                    const checkDisconnected = () => {
                        if (!connection.client.connected) {
                            resolve()
                        } else {
                            setTimeout(checkDisconnected, 100)
                        }
                    }
                    setTimeout(resolve, 5000) // 最多等待5秒
                    checkDisconnected()
                })

                delete wsConnections.value[tokenId]
                updateCrossTabConnectionState(tokenId, 'disconnected')
                wsLogger.info(`连接已优雅关闭: ${tokenId}`)
            }
        } catch (error) {
            wsLogger.error(`关闭连接失败 [${tokenId}]:`, error)
        } finally {
            releaseConnectionLock(tokenId, 'disconnect')
        }
    }

    // 同步版本的关闭连接（保持向后兼容）
    const closeWebSocketConnection = (tokenId) => {
        closeWebSocketConnectionAsync(tokenId).catch(error => {
            wsLogger.error(`关闭连接异步操作失败 [${tokenId}]:`, error)
        })
    }

    const getWebSocketStatus = (tokenId) => {
        return wsConnections.value[tokenId]?.status || 'disconnected'
    }

    // 获取WebSocket客户端
    const getWebSocketClient = (tokenId) => {
        return wsConnections.value[tokenId]?.client || null
    }

    // 设置消息监听器
    const setMessageListener = (listener) => {
        if (selectedToken.value) {
            const connection = wsConnections.value[selectedToken.value.id]
            if (connection && connection.client) {
                connection.client.setMessageListener(listener)
            }
        }
    }

    // 设置是否显示消息
    const setShowMsg = (show) => {
        if (selectedToken.value) {
            const connection = wsConnections.value[selectedToken.value.id]
            if (connection && connection.client) {
                connection.client.setShowMsg(show)
            }
        }
    }


    // 发送消息到WebSocket
    const sendMessage = (tokenId, cmd, params = {}, options = {}) => {
        const connection = wsConnections.value[tokenId]
        if (!connection || connection.status !== 'connected') {
            wsLogger.error(`WebSocket未连接，无法发送消息 [${tokenId}]`)
            return false
        }

        try {
            const client = connection.client
            if (!client) {
                wsLogger.error(`WebSocket客户端不存在 [${tokenId}]`)
                return false
            }

            client.send(cmd, params, options)
            wsLogger.wsMessage(tokenId, cmd, false)

            return true
        } catch (error) {
            wsLogger.error(`发送失败 [${tokenId}] ${cmd}:`, error.message)
            return false
        }
    }

    // Promise版发送消息
    const sendMessageWithPromise = async (tokenId, cmd, params = {}, timeout = 5000) => {
        const connection = wsConnections.value[tokenId]
        if (!connection || connection.status !== 'connected') {
            return Promise.reject(new Error(`WebSocket未连接 [${tokenId}]`))
        }

        const client = connection.client
        if (!client) {
            return Promise.reject(new Error(`WebSocket客户端不存在 [${tokenId}]`))
        }

        try {
            const result = await client.sendWithPromise(cmd, params, timeout)

            // 特殊日志：fight_starttower 响应
            if (cmd === 'fight_starttower') {
                wsLogger.info(`🗼 [咸将塔] 收到爬塔响应 [${tokenId}]:`, result)
            }

            return result
        } catch (error) {
            // 特殊日志：fight_starttower 错误
            if (cmd === 'fight_starttower') {
                wsLogger.error(`🗼 [咸将塔] 爬塔请求失败 [${tokenId}]:`, error.message)
            }
            return Promise.reject(error)
        }
    }

    // 发送心跳消息
    const sendHeartbeat = (tokenId) => {
        return sendMessage(tokenId, 'heart_beat')
    }

    // 发送获取角色信息请求（异步处理）
    const sendGetRoleInfo = async (tokenId, params = {}) => {
        try {
            const roleInfo = await sendMessageWithPromise(tokenId, 'role_getroleinfo', params, 10000)

            // 手动更新游戏数据（因为响应可能不会自动触发消息处理）
            if (roleInfo) {
                gameData.value.roleInfo = roleInfo
                gameData.value.lastUpdated = new Date().toISOString()
                gameLogger.verbose('角色信息已通过 Promise 更新')
            }

            return roleInfo
        } catch (error) {
            gameLogger.error(`获取角色信息失败 [${tokenId}]:`, error.message)
            throw error
        }
    }

    // 发送获取数据版本请求
    const sendGetDataBundleVersion = (tokenId, params = {}) => {
        return sendMessageWithPromise(tokenId, 'system_getdatabundlever', params)
    }

    // 发送签到请求
    const sendSignIn = (tokenId) => {
        return sendMessageWithPromise(tokenId, 'system_signinreward')
    }

    // 发送领取日常任务奖励
    const sendClaimDailyReward = (tokenId, rewardId = 0) => {
        return sendMessageWithPromise(tokenId, 'task_claimdailyreward', {rewardId})
    }

    // 发送获取队伍信息
    const sendGetTeamInfo = (tokenId, params = {}) => {
        return sendMessageWithPromise(tokenId, 'presetteam_getinfo', params)
    }

    // 发送自定义游戏消息
    const sendGameMessage = (tokenId, cmd, params = {}, options = {}) => {
        if (options.usePromise) {
            return sendMessageWithPromise(tokenId, cmd, params, options.timeout)
        } else {
            return sendMessage(tokenId, cmd, params, options)
        }
    }

    // 获取当前塔层数
    const getCurrentTowerLevel = () => {
        try {
            // 从游戏数据中获取塔信息
            const roleInfo = gameData.value.roleInfo
            if (!roleInfo || !roleInfo.role) {
                gameLogger.warn('角色信息不存在')
                return null
            }

            const tower = roleInfo.role.tower
            if (!tower) {
                gameLogger.warn('塔信息不存在')
                return null
            }

            // 可能的塔层数字段（根据实际数据结构调整）
            const level = tower.level || tower.currentLevel || tower.floor || tower.stage

            // 当前塔层数
            return level
        } catch (error) {
            gameLogger.error('获取塔层数失败:', error)
            return null
        }
    }

    // 获取详细塔信息
    const getTowerInfo = () => {
        try {
            const roleInfo = gameData.value.roleInfo
            if (!roleInfo || !roleInfo.role) {
                return null
            }

            return roleInfo.role.tower || null
        } catch (error) {
            gameLogger.error('获取塔信息失败:', error)
            return null
        }
    }

    // 工具方法
    const exportTokens = () => {
        return {
            tokens: gameTokens.value,
            exportedAt: new Date().toISOString(),
            version: '2.0'
        }
    }

    const importTokens = (data) => {
        try {
            if (data.tokens && Array.isArray(data.tokens)) {
                gameTokens.value = data.tokens
                saveTokensToStorage()
                return {success: true, message: `成功导入 ${data.tokens.length} 个Token`}
            } else {
                return {success: false, message: '导入数据格式错误'}
            }
        } catch (error) {
            return {success: false, message: '导入失败：' + error.message}
        }
    }

    const clearAllTokens = () => {
        // 关闭所有WebSocket连接
        Object.keys(wsConnections.value).forEach(tokenId => {
            closeWebSocketConnection(tokenId)
        })

        gameTokens.value = []
        selectedTokenId.value = null
        localStorage.removeItem('gameTokens')
        localStorage.removeItem('selectedTokenId')
    }

    const cleanExpiredTokens = () => {
        const now = new Date()
        const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

        const cleanedTokens = gameTokens.value.filter(token => {
            // URL导入的token设为长期有效，不会过期
            if (token.importMethod === 'url') {
                return true
            }

            // 手动导入的token按原逻辑处理（24小时过期）
            const lastUsed = new Date(token.lastUsed || token.createdAt)
            return lastUsed > oneDayAgo
        })

        const cleanedCount = gameTokens.value.length - cleanedTokens.length
        gameTokens.value = cleanedTokens
        saveTokensToStorage()

        return cleanedCount
    }

    // 将现有token升级为长期有效
    const upgradeTokenToPermanent = (tokenId) => {
        const token = gameTokens.value.find(t => t.id === tokenId)
        if (token && token.importMethod !== 'url') {
            updateToken(tokenId, {
                importMethod: 'url',
                upgradedToPermanent: true,
                upgradedAt: new Date().toISOString()
            })
            return true
        }
        return false
    }

    const saveTokensToStorage = () => {
        localStorage.setItem('gameTokens', JSON.stringify(gameTokens.value))
    }

    // 连接唯一性验证和监控
    const validateConnectionUniqueness = (tokenId) => {
        const connections = Object.values(wsConnections.value).filter(conn =>
            conn.tokenId === tokenId &&
            (conn.status === 'connecting' || conn.status === 'connected')
        )

        if (connections.length > 1) {
            wsLogger.warn(`检测到重复连接: ${tokenId}, 连接数: ${connections.length}`)
            // 保留最新的连接，关闭旧连接
            const sortedConnections = connections.sort((a, b) =>
                new Date(b.connectedAt || 0) - new Date(a.connectedAt || 0)
            )

            for (let i = 1; i < sortedConnections.length; i++) {
                const oldConnection = sortedConnections[i]
                wsLogger.debug(`关闭重复连接: ${tokenId}`)
                closeWebSocketConnectionAsync(oldConnection.tokenId)
            }

            return false // 检测到重复连接
        }

        return true // 连接唯一
    }

    // 连接监控和清理
    const connectionMonitor = {
        // 定期检查连接状态
        startMonitoring: () => {
            setInterval(() => {
                const now = Date.now()

                // 检查连接超时（超过30秒未活动）
                Object.entries(wsConnections.value).forEach(([tokenId, connection]) => {
                    const lastActivity = connection.lastMessage?.timestamp || connection.connectedAt
                    if (lastActivity) {
                        const timeSinceActivity = now - new Date(lastActivity).getTime()

                        if (timeSinceActivity > 30000 && connection.status === 'connected') {
                            wsLogger.warn(`检测到连接可能已断开: ${tokenId}`)
                            // 发送心跳检测
                            if (connection.client) {
                                connection.client.sendHeartbeat()
                            }
                        }
                    }
                })

                // 清理过期的连接锁（超过10分钟）
                connectionLocks.value.forEach((lock, key) => {
                    if (now - lock.timestamp > 600000) {
                        wsLogger.debug(`清理过期连接锁: ${key}`)
                        connectionLocks.value.delete(key)
                    }
                })

                // 清理过期的跨标签页状态（超过5分钟）
                activeConnections.value.forEach((state, tokenId) => {
                    if (now - state.timestamp > 300000) {
                        wsLogger.debug(`清理过期跨标签页状态: ${tokenId}`)
                        activeConnections.value.delete(tokenId)
                        localStorage.removeItem(`ws_connection_${tokenId}`)
                    }
                })

            }, 10000) // 每10秒检查一次
        },

        // 获取连接统计信息
        getStats: () => {
            const stats = {
                totalConnections: Object.keys(wsConnections.value).length,
                connectedCount: 0,
                connectingCount: 0,
                disconnectedCount: 0,
                errorCount: 0,
                duplicateTokens: [],
                activeLocks: connectionLocks.value.size,
                crossTabStates: activeConnections.value.size
            }

            // 统计连接状态
            const tokenCounts = new Map()
            Object.values(wsConnections.value).forEach(connection => {
                stats[connection.status + 'Count']++

                // 检测重复token
                const count = tokenCounts.get(connection.tokenId) || 0
                tokenCounts.set(connection.tokenId, count + 1)

                if (count > 0) {
                    stats.duplicateTokens.push(connection.tokenId)
                }
            })

            return stats
        },

        // 强制清理所有连接
        forceCleanup: async () => {
            wsLogger.info('开始强制清理所有连接...')

            const cleanupPromises = Object.keys(wsConnections.value).map(tokenId =>
                closeWebSocketConnectionAsync(tokenId)
            )

            await Promise.all(cleanupPromises)

            // 清理所有锁和状态
            connectionLocks.value.clear()
            activeConnections.value.clear()

            // 清理localStorage中的跨标签页状态
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('ws_connection_')) {
                    localStorage.removeItem(key)
                }
            })

            wsLogger.info('强制清理完成')
        }
    }

    // 监听localStorage变化（跨标签页通信）
    const setupCrossTabListener = () => {
        window.addEventListener('storage', (event) => {
            if (event.key?.startsWith('ws_connection_')) {
                const tokenId = event.key.replace('ws_connection_', '')
                wsLogger.debug(`检测到跨标签页连接状态变化: ${tokenId}`, event.newValue)

                // 如果其他标签页建立了连接，考虑关闭本标签页的连接
                if (event.newValue) {
                    try {
                        const newState = JSON.parse(event.newValue)
                        const localConnection = wsConnections.value[tokenId]

                        if (newState.action === 'connected' &&
                            newState.sessionId !== currentSessionId &&
                            localConnection?.status === 'connected') {
                            wsLogger.info(`检测到其他标签页已连接同一token，关闭本地连接: ${tokenId}`)
                            closeWebSocketConnectionAsync(tokenId)
                        }
                    } catch (error) {
                        wsLogger.warn('解析跨标签页状态失败:', error)
                    }
                }
            }
        })
    }

    // 初始化
    const initTokenStore = () => {
        // 恢复数据
        const savedTokens = localStorage.getItem('gameTokens')
        const savedSelectedId = localStorage.getItem('selectedTokenId')

        if (savedTokens) {
            try {
                gameTokens.value = JSON.parse(savedTokens)
            } catch (error) {
                tokenLogger.error('解析Token数据失败:', error.message)
                gameTokens.value = []
            }
        }

        if (savedSelectedId) {
            selectedTokenId.value = savedSelectedId
        }

        // 清理过期token
        cleanExpiredTokens()

        // 启动连接监控
        connectionMonitor.startMonitoring()

        // 设置跨标签页监听
        setupCrossTabListener()

        tokenLogger.info('Token Store 初始化完成，连接监控已启动')
    }

    return {
        // 状态
        gameTokens,
        selectedTokenId,
        wsConnections,
        gameData,

        // 计算属性
        hasTokens,
        selectedToken,
        selectedTokenRoleInfo,

        // Token管理方法
        addToken,
        updateToken,
        removeToken,
        selectToken,

        // Base64解析方法
        parseBase64Token,
        importBase64Token,

        // WebSocket方法
        createWebSocketConnection,
        closeWebSocketConnection,
        getWebSocketStatus,
        getWebSocketClient,
        sendMessage,
        sendMessageWithPromise,
        setMessageListener,
        setShowMsg,
        sendHeartbeat,
        sendGetRoleInfo,
        sendGetDataBundleVersion,
        sendSignIn,
        sendClaimDailyReward,
        sendGetTeamInfo,
        sendGameMessage,

        // 工具方法
        exportTokens,
        importTokens,
        clearAllTokens,
        cleanExpiredTokens,
        upgradeTokenToPermanent,
        initTokenStore,

        // 塔信息方法
        getCurrentTowerLevel,
        getTowerInfo,

        // 调试工具方法
        validateToken,
        debugToken: (tokenString) => {
            console.log('🔍 Token调试信息:')
            console.log('原始Token:', tokenString)
            const parseResult = parseBase64Token(tokenString)
            console.log('解析结果:', parseResult)
            if (parseResult.success) {
                console.log('实际Token:', parseResult.data.actualToken)
                console.log('Token有效性:', validateToken(parseResult.data.actualToken))
            }
            return parseResult
        },

        // 连接管理增强功能
        validateConnectionUniqueness,
        connectionMonitor,
        currentSessionId: () => currentSessionId,

        // 开发者工具
        devTools: {
            getConnectionStats: () => connectionMonitor.getStats(),
            forceCleanup: () => connectionMonitor.forceCleanup(),
            showConnectionLocks: () => Array.from(connectionLocks.value.entries()),
            showCrossTabStates: () => Array.from(activeConnections.value.entries()),
            testDuplicateConnection: (tokenId) => {
                // 降噪
                const token = gameTokens.value.find(t => t.id === tokenId)
                if (token) {
                    // 故意创建第二个连接进行测试
                    createWebSocketConnection(tokenId + '_test', token.token)
                }
            }
        }
    }
})
