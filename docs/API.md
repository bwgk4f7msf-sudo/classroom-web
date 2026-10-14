# 后端接口与附录对应关系

所有路径以 `/api` 为前缀。JSON 写请求使用 `Content-Type: application/json`；图片接口使用 `multipart/form-data`，字段 `file`，最多一张 JPEG/PNG，最大 5 MiB。服务不保留上传临时文件。CompreFace 凭据只从服务端环境变量读取。

Web 使用 `credentials: 'include'`；Android 使用持久 CookieJar。认证采用 HttpOnly `connect.sid` Cookie，**不返回或接受客户端自报角色作为授权依据**。刷新接口轮换 Session ID，旧 Cookie 立即失效。业务接口每次检查数据库会话、账户状态、角色和资源归属。

响应：列表 `{items: [...]}`，新建 `{id}`，普通写入 `{success:true}`；错误 `{success:false,message,code?}`。常见状态码：400 参数错误，401 未登录，403 越权，404 不存在，409 重复/状态冲突，413 上传过大，422 无法识别图片，429 限流，503 人脸服务不可用。人脸异常考勤返回 202，表示已记为 exception、等待复核，不代表签到成功。

## 登录与账户

| 方法 | 路径 | 请求或用途 |
|---|---|---|
| GET | `/captcha` | 返回 `{image}`（SVG data URL），验证码 5 分钟有效，一次性使用，与 Cookie 绑定 |
| POST | `/auth/register` | `{username,password,role,code,name,student_no?/teacher_no?}`；role 为 student/teacher；教师为 pending；新注册、重复账号与重复学号 / 工号统一返回 202 和相同受理话术，requiresApproval 仅取决于提交的角色，不表示已创建账号 |
| POST | `/auth/login` | `{username,password,code}`，返回 `{success,user}` |
| GET | `/auth/me` | 当前用户的 id、username、role、avatar |
| POST | `/auth/logout` | 空请求体或 `{}` 均支持，销毁会话并清 Cookie；重复调用可成功 |
| POST | `/auth/refresh` | `{}`；轮换 Cookie，返回 `{success,user}` |
| PATCH | `/auth/password` | `{currentPassword,password}`；注销此用户的全部会话，随后重新登录 |
| GET | `/users` | 管理员查询用户，不返回密码哈希 |
| PATCH | `/users/{id}` | 管理员提交 `{status:"active"或"disabled"}`；审核教师或停用账户；不允许通过此接口停用管理员 |

旧的 `/user/login`、`/user/register`、`/user/me`、`/user/logout` 保留兼容。注册账号 3–24 位文字、数字、下划线或短横线；密码至少 8 位，最多 72 UTF-8 字节，含数字和非数字。初始管理员密码至少 12 位。

## 审批、排课、资料与通知

教师课程变更返回 `202 {requestId,requiresApproval:true}`，批准前不修改有效课表；管理员直接修改返回 200。审批生效和通知写入在同一事务内，失败回滚。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/profile` | 查询本人资料（管理员返回 null） |
| POST | `/profile/name-request` | 学生 / 教师提交 `{name}`，返回 202 |
| GET | `/requests` | 管理员看全部申请，其他人仅看本人；payload 为解析后的对象 |
| PATCH | `/requests/{id}` | 管理员提交 `{status: approved/rejected,note}`；重置密码申请可拒绝，批准须走专用重设密码接口 |
| POST | `/auth/reset-request` | 无需登录，提交 `{username,role,number,name,code}`；role 仅 student/teacher；验证码及资料匹配后仅创建待办，返回 202；账号及会话保持有效，每账号 24 小时限一次（429） |
| POST | `/users/{id}/reset-password` | 管理员提交 `{password}`，重设学生 / 教师密码、解禁并完成待处理重置申请 |
| GET | `/schedule` | 按角色和选课关系查询课程与课次 |
| POST | `/scheduled-courses` | 教师提交 `{course_name,english_name,name,term,schedule}` |
| PUT | `/scheduled-courses/{id}` | 教师申请 / 管理员直接替换后续安排，上述字段加必填 reason |
| PATCH | `/course-sessions/{id}` | 教师申请 / 管理员直接调单次课，提交 `{date,start,end,location,reason}`（北京时间） |
| POST | `/scheduled-courses/{id}/cancel` | 教师申请 / 管理员直接取消整个教学班，提交 `{reason}` |
| GET | `/student-candidates?q=...` | 教师仅按完整学号精确查询最多 1 个有效学生；管理员按学号或姓名模糊查询最多 20 个；返回 id、student_no、name |
| POST | `/scheduled-courses/{id}/students` | 教师 / 管理员按 `{student_no}` 添加学生；教师仅限本人课程 |
| GET | `/notifications` | 学生查询本人所有未关闭课程通知 |
| PATCH | `/notifications/{id}/close` | 学生手动关闭本人通知，无需 body |

schedule 字段为 `{date,start,end,location,repeat,interval?,weekdays?,until?}`；repeat 为 once / daily / weekly，日期为 YYYY-MM-DD、时间为 HH:mm，weekdays 使用 0–6（周日–周六），统一北京时间。

申请状态为 pending / approved / rejected；审核须填写说明，已处理申请不能重复审核。批准课程申请时重新检查权限、有效状态、未来时间及冲突。密码重置申请不影响管理员通过 `PATCH /users/{id}` 独立启用或停用账号。

## 基础资料

| 方法 | 路径 | 权限与请求 |
|---|---|---|
| GET | `/students`、`/teachers` | 管理员查询；资料随注册自动创建，注册时必填学号 / 工号和姓名；旧资料保留 |
| PATCH | `/students/{id}` | 管理员：`{name?,class_name?}；学号不可修改` |
| PATCH | `/teachers/{id}` | 管理员：`{name?}；工号不可修改` |
| GET | `/courses` | 管理员、教师 |
| POST | `/courses` | 管理员：`{course_code,course_name,credit?}` |
| PATCH | `/courses/{id}` | 管理员：`{course_code?,course_name?,credit?,status?}`，status 为 active/archived |
| DELETE | `/courses/{id}` | 管理员：归档，保留历史数据 |
| GET | `/teaching-classes` | 管理员全部、教师本人、学生有效选课 |
| POST | `/teaching-classes` | 管理员：`{course_id,teacher_id,term,name}` |
| PATCH | `/teaching-classes/{id}` | 管理员：`{name?,term?,status?}` |
| DELETE | `/teaching-classes/{id}` | 管理员：归档，停止该班签到 |
| GET | `/teaching-classes/{id}/enrollments` | 管理员或对应教师 |
| POST | `/teaching-classes/{id}/enrollments` | 管理员或对应教师：`{student_id}`；重复选课返回 409 |
| PATCH | `/enrollments/{id}` | 管理员或对应教师：`{status:"active"或"withdrawn"}` |

不物理删除用户、课程、教学班和历史考勤，避免级联删除审计数据。账户停用使用 `/users/{id}`。恢复退课关系使用 PATCH，不重新插入。

## 考勤与统计

| 方法 | 路径 | 权限与请求 |
|---|---|---|
| POST | `/attendance-tasks` | 对应教师：`{teaching_class_id,start_at,late_at,end_at}` |
| GET | `/attendance-tasks` | 教师本人任务列表 |
| PATCH | `/attendance-tasks/{id}` | 对应教师：`{status:"paused"或"active"}`；已结束/过期不能重开 |
| POST | `/attendance-tasks/{id}/end` | 对应教师：结束，尚无记录的有效成员补记 absent；重复结束不重复插入 |
| GET | `/attendance-tasks/available` | 学生：有效选课、未归档班级、当前开放时间内的任务 |
| POST | `/attendance-tasks/{id}/check-in` | 学生：multipart 图片；先校验身份、选课、时段和重复记录，再调用识别；落库前再检查 |
| GET | `/attendance/me` | 学生本人记录 |
| GET | `/attendance-tasks/{id}/records` | 对应教师 |
| POST | `/attendance-tasks/{id}/manual` | 对应教师：`{student_id,status?,reason}`，非人脸替代流程，status 默认 manual；已有记录则使用 review |
| PATCH | `/attendance-records/{id}/review` | 对应教师：`{status,reason}`，事务写入修改前后状态、操作者和原因，再更新结果 |
| GET | `/attendance-records/{id}/reviews` | 对应教师：完整复核轨迹 |
| GET | `/reports/teaching-classes/{id}` | 对应教师：counts、total、attendanceRate、items；`?format=csv` 导出（含公式注入转义） |
| GET | `/audit-logs` | 管理员；`?limit=100&before=记录ID`，最大 500 条，按 ID 倒序分页 |

时间必须带时区，如 `2026-09-24T08:00:00+08:00`，统一转为 UTC 存储。要求 `start_at ≤ late_at ≤ end_at` 且 start < end；签到区间为 `[start_at,end_at)`，等于 late_at 判迟到。状态包括 present、late、absent、leave、exception、manual。相似度不足、无人脸、多人脸记录为 exception，必须复核；服务故障不写考勤记录，允许重试或人工登记。

出勤率 = `(present + late + manual) / (记录总数 - leave)`；没有分母时为 null。尚未结束的任务未签到者还没有 absent 记录，因此最终统计应先结束任务。超过 end_at 会立即阻止签到，但需要教师调用 end 完成缺勤归档。选课关系采用任务结束时的有效名单，当前版本未做开课名单快照。

## 人脸同意、登记和删除

| 方法 | 路径 | 学生本人请求 |
|---|---|---|
| POST | `/faces/consent` | `{policy_version,decision:"agree"或"withdraw"}`；记录独立决定，撤回立即禁用资料并尝试删除远端样本 |
| POST | `/faces/register` | multipart 图片；必须有最近一次 agree；更新会替换原样本 |
| GET | `/faces/me` | consent 和 profile 状态，不返回内部 subject_key 或样本 |
| DELETE | `/faces/me` | 删除样本和停用映射，保留业务审计 |

远端删除失败返回 `202 {success:true,deletionPending:true}`，资料状态为 pending_delete，不能签到；服务恢复后重复 DELETE 完成清理。登记中断也保留不透明 subject_key 以便重试清理，不能把数据库删除当成远端已经删除。删除本身不撤回授权，撤回请调用 consent。人脸服务未配置时其他基础业务正常工作。

当前没有自动重试删除的后台任务；部署方需要处理 pending_delete。真实 CompreFace 的安装与识别效果需在 x86-64 目标设备验证。适配接口依据 [CompreFace 官方 REST 文档](https://github.com/exadel-inc/CompreFace/blob/master/docs/Rest-API-description.md)，不包含活体检测实现。

## 一次完整联调

1. GET captcha 保存 Cookie，POST auth/register 注册学生和教师；管理员登录后 GET users，PATCH users/{教师账号ID} 激活。
2. 管理员 GET teachers/students 获取资料 ID，创建 courses、teaching-classes；添加 enrollments。
3. 教师登录，为本人班级创建 attendance-tasks。
4. 学生登录，记录 faces/consent，再上传 faces/register，查询 available 并 check-in。
5. 无人脸条件时，教师使用 manual；已有异常用 review 修正，GET reviews 核对留痕。
6. 教师 end 后查询 records、reports 或导出 CSV；管理员核对 audit-logs。
7. POST auth/logout，再用退出前的 Cookie 请求 auth/me 或 auth/refresh，均应为 401。
