package storage

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func fixedNow(t *testing.T) func() time.Time {
	t.Helper()
	fixed := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	return func() time.Time { return fixed }
}

func TestPresignGetFixedVector(t *testing.T) {
	// 固定向量来自 AWS SigV4 文档示例，用于校验规范串与签名实现。
	s := &S3{
		Endpoint:  "https://s3.amazonaws.com",
		Region:    "us-east-1",
		Bucket:    "examplebucket",
		AccessKey: "AKIAIOSFODNN7EXAMPLE",
		SecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		PathStyle: false,
		Now:       func() time.Time { return time.Date(2013, 5, 24, 0, 0, 0, 0, time.UTC) },
	}
	got, err := s.PresignGet("test.txt", 24*time.Hour)
	if err != nil {
		t.Fatalf("presign get: %v", err)
	}
	want := "https://examplebucket.s3.amazonaws.com/test.txt" +
		"?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
		"&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
		"&X-Amz-Date=20130524T000000Z" +
		"&X-Amz-Expires=86400" +
		"&X-Amz-SignedHeaders=host" +
		"&X-Amz-Signature=3ed0be64024db54d5574a27da223529635c383f911f80e636f0ccc13890053d2"
	if got != want {
		t.Fatalf("presigned url mismatch\n got: %s\nwant: %s", got, want)
	}
}

func TestSignRequestFixedVector(t *testing.T) {
	s := &S3{
		Endpoint:  "https://s3.example.com",
		Region:    "us-east-1",
		Bucket:    "assets",
		AccessKey: "AKIAIOSFODNN7EXAMPLE",
		SecretKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
		PathStyle: true,
		Now:       func() time.Time { return time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC) },
	}
	u, err := s.objectURL("ws/demo.png")
	if err != nil {
		t.Fatalf("object url: %v", err)
	}
	req, err := http.NewRequest(http.MethodPut, u.String(), bytes.NewReader([]byte("hello")))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	hash := sha256HexBytes([]byte("hello"))
	req.Header.Set("x-amz-content-sha256", hash)
	s.signRequest(req, hash)

	want := "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261102/us-east-1/s3/aws4_request, " +
		"SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
		"Signature=dd1de4271b815aaeafc03e5566f3e7b3193a4b82e7b4b02d7affc66e913f155d"
	if got := req.Header.Get("Authorization"); got != want {
		t.Fatalf("authorization mismatch\n got: %s\nwant: %s", got, want)
	}
	if got := req.Header.Get("x-amz-date"); got != "20261102T120000Z" {
		t.Fatalf("x-amz-date = %s", got)
	}
}

type recordedRequest struct {
	method string
	path   string
	sha    string
	auth   string
	date   string
}

func TestS3StoreRoundTrip(t *testing.T) {
	var mu sync.Mutex
	var records []recordedRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		mu.Lock()
		records = append(records, recordedRequest{
			method: r.Method,
			path:   r.URL.Path,
			sha:    r.Header.Get("x-amz-content-sha256"),
			auth:   r.Header.Get("Authorization"),
			date:   r.Header.Get("x-amz-date"),
		})
		mu.Unlock()

		if strings.Contains(r.URL.Path, "missing") {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		switch r.Method {
		case http.MethodGet:
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "hello")
		case http.MethodDelete:
			w.WriteHeader(http.StatusNoContent)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer srv.Close()

	s := &S3{
		Endpoint:  srv.URL,
		Region:    "auto",
		Bucket:    "dk-bucket",
		AccessKey: "AKIATEST",
		SecretKey: "secret-test",
		PathStyle: true,
		HTTP:      srv.Client(),
		Now:       fixedNow(t),
	}

	n, err := s.Save(context.Background(), "ws/1/a.png", strings.NewReader("hello"))
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if n != 5 {
		t.Fatalf("save bytes = %d, want 5", n)
	}

	rc, err := s.Open(context.Background(), "ws/1/a.png")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	body, _ := io.ReadAll(rc)
	rc.Close()
	if string(body) != "hello" {
		t.Fatalf("open body = %q", body)
	}

	if _, err := s.Open(context.Background(), "ws/missing.png"); err == nil || !os.IsNotExist(err) {
		t.Fatalf("missing object should return os.ErrNotExist, got %v", err)
	}
	if err := s.Delete(context.Background(), "ws/1/a.png"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if p := s.Path("ws/1/a.png"); p != "" {
		t.Fatalf("s3 path should be empty, got %q", p)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(records) != 4 {
		t.Fatalf("recorded %d requests, want 4", len(records))
	}
	put := records[0]
	if put.method != http.MethodPut {
		t.Fatalf("save method = %s", put.method)
	}
	if put.path != "/dk-bucket/ws/1/a.png" {
		t.Fatalf("save path = %s", put.path)
	}
	if put.sha != sha256HexBytes([]byte("hello")) {
		t.Fatalf("save payload hash = %s", put.sha)
	}
	if !strings.HasPrefix(put.auth, "AWS4-HMAC-SHA256 Credential=AKIATEST/20260101/auto/s3/aws4_request") {
		t.Fatalf("bad authorization: %s", put.auth)
	}
	if put.date != "20260101T000000Z" {
		t.Fatalf("bad x-amz-date: %s", put.date)
	}

	get := records[1]
	if get.method != http.MethodGet || get.path != "/dk-bucket/ws/1/a.png" {
		t.Fatalf("open request = %s %s", get.method, get.path)
	}
	if get.sha != emptyPayloadHash {
		t.Fatalf("get payload hash = %s", get.sha)
	}

	missing := records[2]
	if missing.path != "/dk-bucket/ws/missing.png" {
		t.Fatalf("missing open path = %s", missing.path)
	}

	del := records[3]
	if del.method != http.MethodDelete || del.path != "/dk-bucket/ws/1/a.png" {
		t.Fatalf("delete request = %s %s", del.method, del.path)
	}
}

func TestPresignPutDiffersFromGet(t *testing.T) {
	s := &S3{
		Endpoint: "https://s3.example.com", Region: "auto", Bucket: "dk-bucket",
		AccessKey: "AKIATEST", SecretKey: "secret-test",
		PathStyle: true, Now: fixedNow(t),
	}
	getURL, err := s.PresignGet("k.png", time.Minute)
	if err != nil {
		t.Fatalf("presign get: %v", err)
	}
	putURL, err := s.PresignPut("k.png", time.Minute)
	if err != nil {
		t.Fatalf("presign put: %v", err)
	}
	g := getURL[strings.Index(getURL, "X-Amz-Signature="):]
	p := putURL[strings.Index(putURL, "X-Amz-Signature="):]
	if g == p {
		t.Fatalf("GET and PUT signatures must differ")
	}
}

func TestPresignTTLValidation(t *testing.T) {
	s := &S3{
		Endpoint: "https://s3.example.com", Region: "auto", Bucket: "dk-bucket",
		AccessKey: "AKIATEST", SecretKey: "secret-test", PathStyle: true,
	}
	for _, ttl := range []time.Duration{0, -time.Minute, 8 * 24 * time.Hour} {
		if _, err := s.PresignGet("k.png", ttl); err == nil {
			t.Fatalf("ttl %s should be rejected", ttl)
		}
	}
}

func TestS3RejectsBadKey(t *testing.T) {
	s := &S3{
		Endpoint: "https://s3.example.com", Region: "auto", Bucket: "dk-bucket",
		AccessKey: "AKIATEST", SecretKey: "secret-test", PathStyle: true,
	}
	for _, k := range []string{"", "/abs", "../escape"} {
		if _, err := s.PresignGet(k, time.Minute); err == nil {
			t.Fatalf("presign key %q should be rejected", k)
		}
		if _, err := s.Save(context.Background(), k, strings.NewReader("x")); err == nil {
			t.Fatalf("save key %q should be rejected", k)
		}
		if _, err := s.Open(context.Background(), k); err == nil {
			t.Fatalf("open key %q should be rejected", k)
		}
		if err := s.Delete(context.Background(), k); err == nil {
			t.Fatalf("delete key %q should be rejected", k)
		}
	}
}

func TestNewS3FromEnvDefaults(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "https://r2.example.com/")
	t.Setenv("S3_REGION", "")
	t.Setenv("S3_BUCKET", "assets")
	t.Setenv("S3_ACCESS_KEY", "AK")
	t.Setenv("S3_SECRET_KEY", "SK")
	t.Setenv("S3_PREFIX", "/designkit/")
	t.Setenv("S3_USE_PATH_STYLE", "")

	s, err := NewS3FromEnv()
	if err != nil {
		t.Fatalf("new s3: %v", err)
	}
	if s.Endpoint != "https://r2.example.com" {
		t.Fatalf("endpoint = %s", s.Endpoint)
	}
	if s.Region != "auto" {
		t.Fatalf("region = %s, want auto", s.Region)
	}
	if !s.PathStyle {
		t.Fatal("path style should default to true")
	}
	if s.Prefix != "designkit" {
		t.Fatalf("prefix = %s", s.Prefix)
	}
	if s.HTTP == nil {
		t.Fatal("http client should be initialized")
	}

	u, err := s.PresignPut("a.png", time.Minute)
	if err != nil {
		t.Fatalf("presign put: %v", err)
	}
	if !strings.HasPrefix(u, "https://r2.example.com/assets/designkit/a.png?") {
		t.Fatalf("unexpected presigned url: %s", u)
	}

	t.Setenv("S3_USE_PATH_STYLE", "true")
	if _, err := NewS3FromEnv(); err != nil {
		t.Fatalf("explicit path style true: %v", err)
	}

	t.Setenv("S3_USE_PATH_STYLE", "maybe")
	if _, err := NewS3FromEnv(); err == nil || !strings.Contains(err.Error(), "S3_USE_PATH_STYLE") {
		t.Fatalf("invalid path style should fail, got %v", err)
	}
}

func TestNewS3FromEnvMissingSecret(t *testing.T) {
	t.Setenv("S3_ENDPOINT", "https://r2.example.com")
	t.Setenv("S3_BUCKET", "assets")
	t.Setenv("S3_ACCESS_KEY", "AK")
	t.Setenv("S3_SECRET_KEY", "")
	if _, err := NewS3FromEnv(); err == nil || !strings.Contains(err.Error(), "S3_SECRET_KEY") {
		t.Fatalf("missing secret should fail, got %v", err)
	}
}
