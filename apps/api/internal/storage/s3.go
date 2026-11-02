package storage

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

// S3 是 S3 兼容对象存储（AWS S3 / Cloudflare R2 / MinIO）的实现。
// 只用标准库完成 SigV4 签名，避免为存储层引入 SDK 依赖。
type S3 struct {
	Endpoint  string
	Region    string
	Bucket    string
	AccessKey string
	SecretKey string
	Prefix    string
	PathStyle bool
	HTTP      *http.Client
	// Now 可在测试中固定时间，生产留空使用 time.Now。
	Now func() time.Time
}

const (
	// 空载荷的 SHA256，GET/DELETE 的 x-amz-content-sha256 使用该值。
	emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	// 预签名 URL 不携带载荷哈希，规范串要求固定使用该占位值。
	unsignedPayload = "UNSIGNED-PAYLOAD"
	amzDateLayout   = "20060102T150405Z"
	presignMaxTTL   = 7 * 24 * time.Hour
)

// NewS3FromEnv 依据环境变量构造 S3 存储；未配置完整时返回中文错误。
func NewS3FromEnv() (*S3, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("S3_ENDPOINT")), "/")
	bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	access := strings.TrimSpace(os.Getenv("S3_ACCESS_KEY"))
	secret := strings.TrimSpace(os.Getenv("S3_SECRET_KEY"))
	missing := make([]string, 0, 4)
	if endpoint == "" {
		missing = append(missing, "S3_ENDPOINT")
	}
	if bucket == "" {
		missing = append(missing, "S3_BUCKET")
	}
	if access == "" {
		missing = append(missing, "S3_ACCESS_KEY")
	}
	if secret == "" {
		missing = append(missing, "S3_SECRET_KEY")
	}
	if len(missing) > 0 {
		return nil, fmt.Errorf("S3 配置不完整：缺少 %s", strings.Join(missing, "、"))
	}

	region := strings.TrimSpace(os.Getenv("S3_REGION"))
	if region == "" {
		region = "auto"
	}
	pathStyle := true
	if v := strings.TrimSpace(os.Getenv("S3_USE_PATH_STYLE")); v != "" {
		parsed, err := parseBoolEnv(v)
		if err != nil {
			return nil, fmt.Errorf("S3_USE_PATH_STYLE 取值无效（%q），应为 true 或 false", v)
		}
		pathStyle = parsed
	}
	s := &S3{
		Endpoint: endpoint, Region: region, Bucket: bucket,
		AccessKey: access, SecretKey: secret,
		Prefix:    strings.Trim(strings.TrimSpace(os.Getenv("S3_PREFIX")), "/"),
		PathStyle: pathStyle,
		HTTP:      &http.Client{Timeout: 60 * time.Second},
	}
	if strings.Contains(s.Bucket, "/") {
		return nil, fmt.Errorf("S3_BUCKET 不能包含斜杠")
	}
	if strings.Contains(s.Prefix, "..") {
		return nil, fmt.Errorf("S3_PREFIX 不能包含 ..")
	}
	if _, err := s.objectURL(""); err != nil {
		return nil, err
	}
	return s, nil
}

func parseBoolEnv(v string) (bool, error) {
	switch strings.ToLower(v) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("无法解析布尔值")
	}
}

// NewFromEnv 按 STORAGE_DRIVER 选择本地或 S3；默认本地。
func NewFromEnv(localDir string) (Store, error) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("STORAGE_DRIVER")), "s3") {
		return NewS3FromEnv()
	}
	return NewLocal(localDir)
}

func (s *S3) region() string {
	if r := strings.TrimSpace(s.Region); r != "" {
		return r
	}
	return "auto"
}

func (s *S3) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// key 校验业务 key 并拼接 S3_PREFIX。
func (s *S3) key(k string) (string, error) {
	if k == "" || strings.HasPrefix(k, "/") || strings.Contains(k, "..") {
		return "", ErrInvalidKey
	}
	if s.Prefix != "" {
		return strings.Trim(s.Prefix, "/") + "/" + k, nil
	}
	return k, nil
}

// objectURL 返回对象的请求地址；PathStyle 兼容 MinIO 与 R2 的自定义端点。
// 同时设置 RawPath，保证实际发送路径与 SigV4 规范串中的编码一致。
func (s *S3) objectURL(key string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimRight(s.Endpoint, "/"))
	if err != nil {
		return nil, fmt.Errorf("S3_ENDPOINT 不合法：%w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("S3_ENDPOINT 必须使用 http 或 https")
	}
	if u.Host == "" {
		return nil, fmt.Errorf("S3_ENDPOINT 缺少主机名")
	}
	if strings.TrimSpace(s.Bucket) == "" {
		return nil, fmt.Errorf("S3_BUCKET 未配置")
	}

	basePath := strings.TrimRight(u.Path, "/")
	host := u.Host
	rawPath := basePath + "/" + key
	if s.PathStyle {
		rawPath = basePath + "/" + s.Bucket + "/" + key
	} else {
		host = s.Bucket + "." + host
	}
	return &url.URL{
		Scheme:  u.Scheme,
		Host:    host,
		Path:    rawPath,
		RawPath: escapePath(rawPath),
	}, nil
}

// escapePath 按 SigV4 规则对对象 key 做 URI 编码，保留斜杠。
func escapePath(key string) string {
	parts := strings.Split(key, "/")
	for i, p := range parts {
		parts[i] = awsEscape(p)
	}
	return strings.Join(parts, "/")
}

func awsEscape(s string) string {
	const hexChars = "0123456789ABCDEF"
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			b.WriteByte('%')
			b.WriteByte(hexChars[c>>4])
			b.WriteByte(hexChars[c&0x0f])
		}
	}
	return b.String()
}

// Save 以 PUT 上传对象，返回实际写入字节数。
// 请求使用真实载荷 SHA256 参与签名，避免部分 S3 兼容实现拒绝 UNSIGNED-PAYLOAD。
func (s *S3) Save(ctx context.Context, key string, r io.Reader) (int64, error) {
	full, err := s.key(key)
	if err != nil {
		return 0, err
	}
	u, err := s.objectURL(full)
	if err != nil {
		return 0, err
	}
	data, err := io.ReadAll(r)
	if err != nil {
		return 0, fmt.Errorf("读取上传数据失败：%w", err)
	}
	payloadHash := sha256HexBytes(data)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), bytes.NewReader(data))
	if err != nil {
		return 0, fmt.Errorf("构造上传请求失败：%w", err)
	}
	req.Header.Set("x-amz-content-sha256", payloadHash)
	s.signRequest(req, payloadHash)
	res, err := s.http().Do(req)
	if err != nil {
		return 0, fmt.Errorf("上传对象失败：网络错误：%w", err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return 0, s.responseError("上传对象", res)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	return int64(len(data)), nil
}

// Open 以 GET 读取对象，调用方负责关闭返回的 ReadCloser；对象不存在时返回 os.ErrNotExist。
func (s *S3) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	full, err := s.key(key)
	if err != nil {
		return nil, err
	}
	u, err := s.objectURL(full)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("构造读取请求失败：%w", err)
	}
	req.Header.Set("x-amz-content-sha256", emptyPayloadHash)
	s.signRequest(req, emptyPayloadHash)
	res, err := s.http().Do(req)
	if err != nil {
		return nil, fmt.Errorf("读取对象失败：网络错误：%w", err)
	}
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		return nil, os.ErrNotExist
	}
	if res.StatusCode != http.StatusOK {
		defer res.Body.Close()
		return nil, s.responseError("读取对象", res)
	}
	return res.Body, nil
}

// Delete 以 DELETE 删除对象；对象不存在视为删除成功。
func (s *S3) Delete(ctx context.Context, key string) error {
	full, err := s.key(key)
	if err != nil {
		return err
	}
	u, err := s.objectURL(full)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, u.String(), nil)
	if err != nil {
		return fmt.Errorf("构造删除请求失败：%w", err)
	}
	req.Header.Set("x-amz-content-sha256", emptyPayloadHash)
	s.signRequest(req, emptyPayloadHash)
	res, err := s.http().Do(req)
	if err != nil {
		return fmt.Errorf("删除对象失败：网络错误：%w", err)
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return s.responseError("删除对象", res)
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	return nil
}

// Path 对对象存储没有本地路径，返回空串。
func (s *S3) Path(string) string { return "" }

func (s *S3) http() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return http.DefaultClient
}

func (s *S3) responseError(op string, res *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(res.Body, 256))
	if msg := strings.TrimSpace(string(body)); msg != "" {
		return fmt.Errorf("%s失败：HTTP %d：%s", op, res.StatusCode, msg)
	}
	return fmt.Errorf("%s失败：HTTP %d", op, res.StatusCode)
}

/* ---------------- SigV4 ---------------- */

// signRequest 给普通 HTTP 请求加 Authorization 头（S3 服务端签名）。
func (s *S3) signRequest(req *http.Request, payloadHash string) {
	now := s.now().UTC()
	amzDate := now.Format(amzDateLayout)
	date := now.Format("20060102")
	req.Header.Set("x-amz-date", amzDate)

	host := req.URL.Host
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalHeaders := fmt.Sprintf("host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", host, payloadHash, amzDate)
	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI(req.URL),
		canonicalQuery(req.URL.Query()),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := date + "/" + s.region() + "/s3/aws4_request"
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest),
	}, "\n")
	signature := hex.EncodeToString(hmacSHA256(s.signingKey(date), []byte(stringToSign)))
	req.Header.Set("Authorization", fmt.Sprintf(
		"AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s",
		s.AccessKey, scope, signedHeaders, signature,
	))
}

// PresignGet 生成带签名的 GET 地址，供前端直出或 CDN 拉取。
func (s *S3) PresignGet(key string, ttl time.Duration) (string, error) {
	return s.presign(http.MethodGet, key, ttl)
}

// PresignPut 生成带签名的 PUT 地址，供客户端直传对象存储。
func (s *S3) PresignPut(key string, ttl time.Duration) (string, error) {
	return s.presign(http.MethodPut, key, ttl)
}

func (s *S3) presign(method, key string, ttl time.Duration) (string, error) {
	full, err := s.key(key)
	if err != nil {
		return "", err
	}
	u, err := s.objectURL(full)
	if err != nil {
		return "", err
	}
	if ttl <= 0 {
		return "", fmt.Errorf("预签名有效期必须大于 0")
	}
	if ttl > presignMaxTTL {
		return "", fmt.Errorf("预签名有效期不能超过 7 天")
	}
	expires := int64(ttl / time.Second)
	if expires < 1 {
		expires = 1
	}

	now := s.now().UTC()
	amzDate := now.Format(amzDateLayout)
	date := now.Format("20060102")
	scope := date + "/" + s.region() + "/s3/aws4_request"

	q := url.Values{}
	q.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	q.Set("X-Amz-Credential", s.AccessKey+"/"+scope)
	q.Set("X-Amz-Date", amzDate)
	q.Set("X-Amz-Expires", fmt.Sprintf("%d", expires))
	q.Set("X-Amz-SignedHeaders", "host")
	query := canonicalQuery(q)

	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI(u),
		query,
		"host:" + u.Host + "\n",
		"host",
		unsignedPayload,
	}, "\n")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest),
	}, "\n")
	signature := hex.EncodeToString(hmacSHA256(s.signingKey(date), []byte(stringToSign)))
	return u.Scheme + "://" + u.Host + canonicalURI(u) + "?" + query + "&X-Amz-Signature=" + signature, nil
}

func (s *S3) signingKey(date string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+s.SecretKey), []byte(date))
	kRegion := hmacSHA256(kDate, []byte(s.region()))
	kService := hmacSHA256(kRegion, []byte("s3"))
	return hmacSHA256(kService, []byte("aws4_request"))
}

func sha256Hex(s string) string {
	return sha256HexBytes([]byte(s))
}

func sha256HexBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	_, _ = h.Write(data)
	return h.Sum(nil)
}

func canonicalURI(u *url.URL) string {
	p := u.EscapedPath()
	if p == "" {
		return "/"
	}
	return p
}

func canonicalQuery(q url.Values) string {
	keys := make([]string, 0, len(q))
	for k := range q {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		vals := append([]string(nil), q[k]...)
		sort.Strings(vals)
		for _, v := range vals {
			parts = append(parts, awsEscape(k)+"="+awsEscape(v))
		}
	}
	return strings.Join(parts, "&")
}

// NormalizeKey 清理调用方传入的对象 key，便于 handler 统一。
func NormalizeKey(k string) string {
	return strings.TrimPrefix(path.Clean("/"+k), "/")
}
