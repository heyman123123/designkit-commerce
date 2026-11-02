package storage

import (
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

const emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const unsignedPayload = "UNSIGNED-PAYLOAD"

// NewS3FromEnv 依据环境变量构造 S3 存储；未配置完整时返回错误。
func NewS3FromEnv() (*S3, error) {
	endpoint := strings.TrimRight(strings.TrimSpace(os.Getenv("S3_ENDPOINT")), "/")
	bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	access := strings.TrimSpace(os.Getenv("S3_ACCESS_KEY"))
	secret := strings.TrimSpace(os.Getenv("S3_SECRET_KEY"))
	if endpoint == "" || bucket == "" || access == "" || secret == "" {
		return nil, fmt.Errorf("S3 配置不完整：需要 S3_ENDPOINT、S3_BUCKET、S3_ACCESS_KEY、S3_SECRET_KEY")
	}
	region := strings.TrimSpace(os.Getenv("S3_REGION"))
	if region == "" {
		region = "auto"
	}
	pathStyle := true
	if v := strings.TrimSpace(os.Getenv("S3_USE_PATH_STYLE")); v != "" {
		pathStyle = v == "1" || strings.EqualFold(v, "true")
	}
	prefix := strings.Trim(strings.TrimSpace(os.Getenv("S3_PREFIX")), "/")
	return &S3{
		Endpoint: endpoint, Region: region, Bucket: bucket,
		AccessKey: access, SecretKey: secret, Prefix: prefix,
		PathStyle: pathStyle,
		HTTP:      &http.Client{Timeout: 60 * time.Second},
	}, nil
}

// NewFromEnv 按 STORAGE_DRIVER 选择本地或 S3；默认本地。
func NewFromEnv(localDir string) (Store, error) {
	if strings.EqualFold(strings.TrimSpace(os.Getenv("STORAGE_DRIVER")), "s3") {
		return NewS3FromEnv()
	}
	return NewLocal(localDir)
}

func (s *S3) key(k string) (string, error) {
	if k == "" || strings.HasPrefix(k, "/") || strings.Contains(k, "..") {
		return "", ErrInvalidKey
	}
	if s.Prefix != "" {
		return s.Prefix + "/" + strings.TrimPrefix(k, "/"), nil
	}
	return k, nil
}

func (s *S3) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// objectURL 返回对象请求地址；PathStyle 兼容 MinIO 与 R2 的自定义端点。
func (s *S3) objectURL(key string) (*url.URL, error) {
	u, err := url.Parse(s.Endpoint)
	if err != nil {
		return nil, fmt.Errorf("S3_ENDPOINT 不合法")
	}
	escaped := escapePath(key)
	if s.PathStyle {
		u.Path = strings.TrimRight(u.Path, "/") + "/" + s.Bucket + "/" + escaped
	} else {
		u.Host = s.Bucket + "." + u.Host
		u.Path = strings.TrimRight(u.Path, "/") + "/" + escaped
	}
	u.RawPath = ""
	return u, nil
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
	var b strings.Builder
	for _, c := range []byte(s) {
		switch {
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}

func (s *S3) Save(ctx context.Context, key string, r io.Reader) (int64, error) {
	full, err := s.key(key)
	if err != nil {
		return 0, err
	}
	u, err := s.objectURL(full)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, u.String(), r)
	if err != nil {
		return 0, err
	}
	req.Header.Set("x-amz-content-sha256", unsignedPayload)
	s.signRequest(req, u, unsignedPayload)
	res, err := s.http().Do(req)
	if err != nil {
		return 0, fmt.Errorf("上传对象失败：网络错误")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return 0, fmt.Errorf("上传对象失败：HTTP %d", res.StatusCode)
	}
	if res.ContentLength > 0 {
		return res.ContentLength, nil
	}
	return 0, nil
}

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
		return nil, err
	}
	req.Header.Set("x-amz-content-sha256", emptyPayloadHash)
	s.signRequest(req, u, emptyPayloadHash)
	res, err := s.http().Do(req)
	if err != nil {
		return nil, fmt.Errorf("读取对象失败：网络错误")
	}
	if res.StatusCode == http.StatusNotFound {
		res.Body.Close()
		return nil, os.ErrNotExist
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("读取对象失败：HTTP %d", res.StatusCode)
	}
	return res.Body, nil
}

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
		return err
	}
	req.Header.Set("x-amz-content-sha256", emptyPayloadHash)
	s.signRequest(req, u, emptyPayloadHash)
	res, err := s.http().Do(req)
	if err != nil {
		return fmt.Errorf("删除对象失败：网络错误")
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("删除对象失败：HTTP %d", res.StatusCode)
	}
	return nil
}

func (s *S3) Path(string) string { return "" }

func (s *S3) http() *http.Client {
	if s.HTTP != nil {
		return s.HTTP
	}
	return http.DefaultClient
}

/* ---------------- SigV4 ---------------- */

// signRequest 给普通 HTTP 请求加 Authorization 头（S3 服务端签名）。
func (s *S3) signRequest(req *http.Request, u *url.URL, payloadHash string) {
	now := s.now().UTC()
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")

	req.Header.Set("x-amz-date", amzDate)
	host := u.Host

	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonicalHeaders := fmt.Sprintf("host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", host, payloadHash, amzDate)
	canonicalRequest := strings.Join([]string{
		req.Method,
		canonicalURI(u),
		canonicalQuery(u.Query()),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	}, "\n")

	scope := date + "/" + s.Region + "/s3/aws4_request"
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
	if ttl <= 0 || ttl > 7*24*time.Hour {
		ttl = 15 * time.Minute
	}
	now := s.now().UTC()
	amzDate := now.Format("20060102T150405Z")
	date := now.Format("20060102")
	scope := date + "/" + s.Region + "/s3/aws4_request"

	q := u.Query()
	q.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	q.Set("X-Amz-Credential", s.AccessKey+"/"+scope)
	q.Set("X-Amz-Date", amzDate)
	q.Set("X-Amz-Expires", fmt.Sprintf("%d", int(ttl.Seconds())))
	q.Set("X-Amz-SignedHeaders", "host")
	u.RawQuery = canonicalQuery(q)

	canonicalRequest := strings.Join([]string{
		method,
		canonicalURI(u),
		u.RawQuery,
		"host:" + u.Host + "\n",
		"host",
		unsignedPayload,
	}, "\n")
	stringToSign := strings.Join([]string{
		"AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest),
	}, "\n")
	signature := hex.EncodeToString(hmacSHA256(s.signingKey(date), []byte(stringToSign)))
	q.Set("X-Amz-Signature", signature)
	u.RawQuery = canonicalQuery(q)
	return u.String(), nil
}

func (s *S3) signingKey(date string) []byte {
	kDate := hmacSHA256([]byte("AWS4"+s.SecretKey), []byte(date))
	kRegion := hmacSHA256(kDate, []byte(s.Region))
	kService := hmacSHA256(kRegion, []byte("s3"))
	return hmacSHA256(kService, []byte("aws4_request"))
}

func sha256Hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func hmacSHA256(key, data []byte) []byte {
	h := hmac.New(sha256.New, key)
	h.Write(data)
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
